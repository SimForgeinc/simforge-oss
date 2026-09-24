import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { z } from 'zod';
import {
  ArtifactIdentitySchema,
  JobFailureSchema,
  RENDER_WORKER_CONTROL_V2_SCHEMA,
  RenderArtifactManifestSchema,
  RenderCanceledError,
  RenderProgressRecordSchema,
  UnsupportedRenderIntentError,
  abortableDelay,
  assertEngineSupportsIntent,
  createFixedSchedules,
  hashFile,
  hashRenderIntent,
  loadBuiltinRenderEngine,
  loadRenderEngine,
  type CompletedArtifact,
  type JobLeasedResponse,
  type RenderArtifactManifest,
  type RenderEngineAdapter,
  type RenderProgressRecord,
  WORKER_CONTROL_FEATURES_LABEL,
  WORKER_PREWARM_FEATURES,
  WORKER_PREWARM_FEATURES_LABEL,
  WORKER_CONTROL_FEATURES_V1,
  WORKER_INPUT_URLS_BATCH_V1,
  WORKER_INPUT_URLS_LABEL,
} from '@simforge-oss/render';
import { collectNativeMapMembers, isNativeMapMemberInputId } from '@simforge-oss/render/native';

import type { RenderWorkerConfig } from './config.js';
import { BlobStore } from './blob-store.js';
import { acquireGpuJobLock, clearStaleGpuLock, gpuLockStatus, type GpuJobLock } from './gpu-lock.js';
import { probeGpuMemory, type GpuMemory } from './gpu-memory.js';
import type { WorkerHealth } from './health.js';
import { withBoundedRetry } from './retry.js';
import { Prewarmer } from './prewarm.js';
import { downloadInputs, uploadFile } from './transfers.js';
import type { RenderControlTransport } from './transport.js';
import { chownWorkspace, configuredContainerIdentity } from './workspace.js';

interface ActiveJobState {
  progressSequence: number;
  leaseExpiresAtMs: number;
  readonly controller: AbortController;
  readonly heartbeatController: AbortController;
  heartbeatError?: unknown;
}

/**
 * Deployed control planes cap `failure` at 2,000 characters; a longer message
 * (a native service log tail) made the fenced failure itself 400, which
 * crashed the worker and left the job leased until expiry. Keep the head and
 * the tail, drop ANSI colour codes.
 */
export function boundedFailureMessage(raw: string, limit = 1800): string {
  // eslint-disable-next-line no-control-regex
  const message = raw.replace(/\u001b\[[0-9;]*m/g, '');
  // The control plane trims and requires a non-empty message; an empty one
  // would fail the report and orphan the lease just like an oversized one.
  if (message.trim().length === 0) return 'render failed without an error message';
  if (message.length <= limit) return message;
  const head = Math.floor(limit * 0.6);
  return `${message.slice(0, head)}\n…[${message.length - limit} chars elided]…\n${message.slice(message.length - (limit - head - 40))}`;
}

/** The control plane's failure code limit (`FailRenderJobV2Schema`); the worker's own schema allows 128. */
const CONTROL_FAILURE_CODE_MAX = 100;

/**
 * What the worker reports for a failed job (`JobFailureSchema`). `details`
 * is structured evidence the engine attached, e.g. a crashed process's exit
 * and scrubbed stderr tail.
 */
export type JobFailure = z.infer<typeof JobFailureSchema>;

export function failureOf(error: unknown): JobFailure {
  const failure = uncappedFailureOf(error);
  return { ...failure, code: failure.code.slice(0, CONTROL_FAILURE_CODE_MAX) };
}

/** An engine error's `details`, when it is a JSON object the control plane can store. */
function failureDetails(error: unknown): JobFailure['details'] {
  const details = (error as { details?: unknown }).details;
  if (!details || typeof details !== 'object' || Array.isArray(details)) return undefined;
  try {
    const round = JSON.parse(JSON.stringify(details)) as unknown;
    return round && typeof round === 'object' && !Array.isArray(round) && Object.keys(round).length > 0
      ? JobFailureSchema.shape.details.parse(round)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A progress record the control plane will accept: warning messages and
 * cancellation reasons are capped at its 2,000 characters (the worker's own
 * schema allows 4,096), so one long engine warning cannot get a whole
 * progress batch refused.
 */
export function boundedProgressRecord(record: RenderProgressRecord): RenderProgressRecord {
  if (record.event === 'warning') return { ...record, message: boundedFailureMessage(record.message) };
  if (record.event === 'job.canceled') return { ...record, reason: boundedFailureMessage(record.reason) };
  return record;
}

/**
 * A completion the control plane refused because the render's evidence
 * records a degradation (docs/engineering/no-silent-fallbacks.md). Final:
 * the same evidence is refused on every retry and by every worker.
 */
export interface CompletionRefusal {
  /** The control plane's evidence code, e.g. `carla_actors_dropped`. */
  readonly code: string;
  /** The job failure code, e.g. `render.carla_actors_dropped`. */
  readonly failureCode: string;
  /** What is degraded, naming the actor, field or value. */
  readonly message: string;
  /** The control plane already failed the job, so the worker must not report it again. */
  readonly jobFailed: boolean;
}

export class CompletionRefusedError extends Error {
  constructor(readonly refusal: CompletionRefusal) {
    super(`control plane refused the render (${refusal.code}): ${refusal.message}`);
    this.name = 'CompletionRefusedError';
  }
}

type RefusalBody = {
  error?: unknown;
  details?: { retryable?: unknown; jobFailed?: unknown; failureCode?: unknown; message?: unknown };
};

const FAILURE_CODE = /^[a-z][a-z0-9_.-]{0,99}$/;
const EVIDENCE_CODE = /^(?:native|carla|render)_[a-z0-9_]+$/;

/**
 * Recognises a final evidence refusal in a completion error: a 409 whose
 * body names an evidence code and says it is not retryable. Every other
 * completion error (a lost lease, storage verification) keeps the bounded
 * retry. Both the OSS HTTP transport and the SimCloud adapter put the
 * response body after `returned 409: `.
 */
export function completionRefusal(error: unknown): CompletionRefusal | null {
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth < 4; depth += 1, current = current.cause) {
    const match = /returned 409: (\{[\s\S]*\})\s*$/.exec(current.message);
    if (!match) continue;
    let body: RefusalBody | null;
    try {
      body = JSON.parse(match[1]!) as RefusalBody | null;
    } catch {
      // A truncated or non-JSON body is not a refusal this worker can read.
      body = null;
    }
    const details = body?.details;
    if (!body || typeof body.error !== 'string' || !EVIDENCE_CODE.test(body.error) || !details || details.retryable !== false) continue;
    const failureCode = typeof details.failureCode === 'string' && FAILURE_CODE.test(details.failureCode)
      ? details.failureCode
      : `render.${body.error}`.slice(0, CONTROL_FAILURE_CODE_MAX);
    return {
      code: body.error,
      failureCode,
      message: typeof details.message === 'string' && details.message.trim() ? details.message : body.error,
      jobFailed: details.jobFailed === true,
    };
  }
  return null;
}

function uncappedFailureOf(error: unknown): JobFailure {
  if (error instanceof CompletionRefusedError) {
    return { code: error.refusal.failureCode, message: boundedFailureMessage(error.refusal.message), retryable: false };
  }
  const message = boundedFailureMessage(error instanceof Error ? error.message : String(error));
  // Engine errors that carry their own machine code and retry verdict (e.g.
  // native_gpu_memory_insufficient) report them as-is.
  const coded = error as { code?: unknown; retryable?: unknown };
  if (error instanceof Error && typeof coded.code === 'string' && /^(?:native|carla|render)_[a-z0-9_]+$/.test(coded.code) && typeof coded.retryable === 'boolean') {
    const details = failureDetails(error);
    return { code: `render.${coded.code}`, message, retryable: coded.retryable, ...(details ? { details } : {}) };
  }
  if (error instanceof RenderCanceledError) return { code: 'render.canceled', message, retryable: false };
  if (error instanceof UnsupportedRenderIntentError) return { code: error.code, message, retryable: false };
  if (/integrity mismatch|intent hash mismatch|invalid/i.test(message)) return { code: 'render.invalid_input', message, retryable: false };
  return { code: 'render.execution_failed', message, retryable: true };
}

/**
 * Admits exactly the inputs the immutable intent declares: every claimed
 * input must match a declared asset's digest and size, and every declared
 * asset must be claimed. Native map members are declared per member
 * (`map.tile.000000` for `master.gltf`, `map.resource.<sha256(path)>` for
 * each resource), so the intent hash binds the complete served closure;
 * their ids must additionally derive from the served `relativePath`, paths
 * must be unique and safe, and the master must be present. Member bytes are
 * hashed on download and the engine refuses a master referencing anything
 * outside the member set.
 */
export function validateClaimedInputs(job: Pick<JobLeasedResponse, 'intent' | 'inputs'>): void {
  const expectedInputs = new Map<string, { sha256: string; sizeBytes: number }>([
    ['scenario.xosc', job.intent.scenarioRevision.openScenario],
    ...job.intent.assets.map((asset) => [asset.assetId, asset] as const),
  ]);
  const claimedInputIds = new Set<string>();
  let hasNativeMembers = false;

  for (const input of job.inputs) {
    if (claimedInputIds.has(input.inputId)) throw new Error(`invalid duplicate claimed input ${input.inputId}`);
    claimedInputIds.add(input.inputId);

    const expected = expectedInputs.get(input.inputId);
    if (!expected) {
      throw new Error(`invalid unreferenced claimed input ${input.inputId}`);
    }
    if (expected && (expected.sha256 !== input.sha256 || expected.sizeBytes !== input.sizeBytes)) {
      throw new Error(`invalid claimed input metadata for ${input.inputId}`);
    }
    hasNativeMembers ||= isNativeMapMemberInputId(input.inputId);
  }
  for (const inputId of expectedInputs.keys()) {
    if (!claimedInputIds.has(inputId)) throw new Error(`invalid missing claimed input ${inputId}`);
  }
  if (hasNativeMembers) collectNativeMapMembers(job.inputs);
}

/**
 * Progress is best effort: a control-plane or network failure is logged and
 * the record dropped (the caller's sequence only advances on an ack), never
 * failing the job or blocking the caller. Records are sent one at a time in
 * order; a queued `stage.progress` snapshot is replaced by a newer one of the
 * same stage instead of piling up behind a slow or failing control plane.
 *
 * Warnings are the exception: an engine warning is never silently lost. A
 * warning that could not be delivered is kept (`undeliveredWarnings`) and the
 * worker resends it before completing, failing the job if it still cannot.
 */
export function createProgressForwarder(
  send: (record: RenderProgressRecord) => Promise<void>,
  stopped: () => boolean,
  log: (event: Record<string, unknown>) => void,
): {
  forward: (record: RenderProgressRecord) => Promise<void>;
  flush: () => Promise<void>;
  undeliveredWarnings: () => RenderProgressRecord[];
} {
  const pending: RenderProgressRecord[] = [];
  const undelivered: RenderProgressRecord[] = [];
  let sender: Promise<void> | undefined;
  const drain = async (): Promise<void> => {
    while (pending.length > 0 && !stopped()) {
      const record = pending.shift()!;
      try {
        await send(record);
      } catch (error) {
        if (record.event === 'warning') undelivered.push(record);
        if (stopped()) return;
        log({ event: 'progress.dropped', progressEvent: record.event, error: error instanceof Error ? error.message : String(error) });
      }
    }
  };
  return {
    forward(candidate) {
      const last = pending.at(-1);
      if (last && last.event === 'stage.progress' && candidate.event === 'stage.progress'
        && (last as { stage?: string }).stage === (candidate as { stage?: string }).stage) {
        pending[pending.length - 1] = candidate;
      } else {
        pending.push(candidate);
      }
      sender ??= drain().finally(() => { sender = undefined; });
      return Promise.resolve();
    },
    async flush() {
      while (sender) await sender;
    },
    undeliveredWarnings() {
      return [...undelivered, ...pending.filter((record) => record.event === 'warning')];
    },
  };
}

/**
 * The warnings an engine returned in its manifest, as progress records. The
 * baseline `warning` progress event carries them to the control plane, which
 * persists them per attempt and shows them with the job; no newer output
 * field is needed. Render-affecting conditions are failures in the engines
 * (docs/engineering/no-silent-fallbacks.md), so what arrives here is
 * informational, but it is still never dropped.
 */
export function engineWarningRecords(
  manifest: Pick<RenderArtifactManifest, 'warnings'>,
  job: Pick<JobLeasedResponse, 'jobId' | 'attempt'>,
  now = new Date(),
): RenderProgressRecord[] {
  return manifest.warnings.map((warning) => ({
    schema: 'simforge.render-progress/v1',
    event: 'warning',
    code: warning.code,
    message: warning.message,
    jobId: job.jobId,
    attempt: job.attempt,
    sequence: 0,
    timestamp: now.toISOString(),
  }));
}

/**
 * A failed heartbeat ends the job only when the control plane says the lease
 * is gone (409) or the last acknowledged expiry is about to pass; a flaky
 * link otherwise costs nothing while the lease still holds.
 */
export function heartbeatFailureIsFatal(error: unknown, leaseExpiresAtMs: number, intervalMs: number, now = Date.now()): boolean {
  const leaseGone = error instanceof Error && /returned 409\b|lease_invalid/i.test(error.message);
  return leaseGone || now >= leaseExpiresAtMs - Math.max(10_000, intervalMs);
}

const finishedJobs = new Set<string>();

/** Whether `jobId` was run (and finished) by this worker: this process, or a workspace a previous process left. */
export async function ownPastJob(scratchDir: string, jobId: string): Promise<boolean> {
  if (finishedJobs.has(jobId)) return true;
  try {
    return (await readdir(scratchDir)).some((name) => name.startsWith(`${jobId}-`));
  } catch {
    return false;
  }
}

async function loadConfiguredEngine(config: RenderWorkerConfig): Promise<RenderEngineAdapter> {
  if ('id' in config.engine) return loadBuiltinRenderEngine(config.engine.id, config.engine.options);
  return loadRenderEngine(config.engine.module, config.engine.options);
}

async function runHeartbeat(
  transport: RenderControlTransport,
  job: JobLeasedResponse,
  state: ActiveJobState,
  intervalMs: number,
  retryConfig: RenderWorkerConfig['retries'],
): Promise<void> {
  const heartbeatSignal = AbortSignal.any([state.controller.signal, state.heartbeatController.signal]);
  while (!heartbeatSignal.aborted) {
    try {
      await abortableDelay(intervalMs, heartbeatSignal);
    } catch (error) {
      if (heartbeatSignal.aborted) return;
      throw error;
    }
    if (heartbeatSignal.aborted) return;
    try {
      const ack = await withBoundedRetry('lease heartbeat', retryConfig, heartbeatSignal, () => transport.heartbeat({
        schema: RENDER_WORKER_CONTROL_V2_SCHEMA,
        type: 'lease.heartbeat',
        leaseId: job.lease.leaseId,
        fenceToken: job.lease.fenceToken,
        progressSequence: state.progressSequence === 0 ? 0 : state.progressSequence - 1,
      }, heartbeatSignal));
      state.leaseExpiresAtMs = Date.parse(ack.leaseExpiresAt);
      if (ack.cancelRequested) {
        state.controller.abort(new RenderCanceledError(ack.cancelReason ?? 'control plane requested cancellation'));
      }
    } catch (error) {
      if (state.heartbeatController.signal.aborted || state.controller.signal.aborted) return;
      // A flaky link must not cost the attempt while the lease still holds:
      // keep heartbeating until the last acknowledged expiry is near. A
      // control plane that says the lease is gone (409) ends the job now.
      if (!heartbeatFailureIsFatal(error, state.leaseExpiresAtMs, intervalMs)) {
        console.error(JSON.stringify({ event: 'lease.heartbeat_failed', jobId: job.jobId, leaseExpiresAt: new Date(state.leaseExpiresAtMs).toISOString(), error: error instanceof Error ? error.message : String(error) }));
        continue;
      }
      state.heartbeatError = error;
      state.controller.abort(new Error('lease heartbeat failed', { cause: error }));
    }
  }
}

async function executeClaim(
  config: RenderWorkerConfig,
  transport: RenderControlTransport,
  engine: RenderEngineAdapter,
  job: JobLeasedResponse,
  heartbeatIntervalMs: number,
  store: BlobStore,
  prewarmer?: Prewarmer,
): Promise<'succeeded' | 'failed'> {

  const workspace = resolve(config.scratchDir, `${job.jobId}-${job.attempt}`);
  const state: ActiveJobState = {
    progressSequence: 0,
    leaseExpiresAtMs: Date.parse(job.lease.expiresAt),
    controller: new AbortController(),
    heartbeatController: new AbortController(),
  };
  const heartbeat = runHeartbeat(transport, job, state, heartbeatIntervalMs, config.retries);
  let gpuLock: GpuJobLock | undefined;
  let outcome: 'succeeded' | 'failed' = 'failed';
  let budgetTimer: NodeJS.Timeout | undefined;

  const sendProgress = async (candidate: RenderProgressRecord): Promise<void> => {
    const record = RenderProgressRecordSchema.parse({
      ...boundedProgressRecord(candidate),
      jobId: job.jobId,
      attempt: job.attempt,
      sequence: state.progressSequence,
      timestamp: new Date().toISOString(),
    });
    const ack = await withBoundedRetry('progress forwarding', config.retries, state.controller.signal, () => transport.progress({
      schema: RENDER_WORKER_CONTROL_V2_SCHEMA,
      type: 'lease.progress',
      leaseId: job.lease.leaseId,
      fenceToken: job.lease.fenceToken,
      records: [record],
    }, state.controller.signal));
    if (ack.acceptedThroughSequence < record.sequence) throw new Error('control plane did not accept forwarded progress sequence');
    state.progressSequence += 1;
  };
  const progress = createProgressForwarder(sendProgress, () => state.controller.signal.aborted, (event) => console.error(JSON.stringify({ ...event, jobId: job.jobId })));
  const forward = progress.forward;
  const flushProgress = progress.flush;
  // Set once the control plane has itself failed the job over its evidence.
  let failedByControlPlane = false;
  const stageStarted = (stage: 'preparing' | 'uploading' | 'finalizing') => forward({
    schema: 'simforge.render-progress/v1', event: 'stage.started', stage,
    jobId: job.jobId, attempt: job.attempt, sequence: 0, timestamp: new Date().toISOString(),
  });

  try {
    const actualIntentSha256 = hashRenderIntent(job.intent);
    if (actualIntentSha256 !== job.intentSha256) {
      throw new Error(`intent hash mismatch: claim=${job.intentSha256} computed=${actualIntentSha256}`);
    }
    assertEngineSupportsIntent(engine.capabilities, job.intent);
    validateClaimedInputs(job);
    await rm(workspace, { recursive: true, force: true });
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    await forward({ schema: 'simforge.render-progress/v1', event: 'job.started', jobId: job.jobId, attempt: job.attempt, sequence: 0, timestamp: new Date().toISOString() });
    const mapVersionId = job.intent.scenarioRevision.map?.revisionId;
    if (mapVersionId) void prewarmer?.noteMapUsed(mapVersionId).catch(() => undefined);
    store.setMode('job-downloading');
    const inputUrls = transport.inputUrls;
    const inputs = await downloadInputs(
      job.inputs,
      workspace,
      store,
      state.controller.signal,
      {
        intent: job.intent,
        ...(engine.selectInputs ? { selectInputs: engine.selectInputs.bind(engine) } : {}),
        placement: engine.inputPlacement ?? 'workspace',
        ...(inputUrls ? {
          inputUrls: async (inputIds, signal) => (await inputUrls.call(transport, {
            schema: RENDER_WORKER_CONTROL_V2_SCHEMA,
            type: 'lease.input-urls',
            leaseId: job.lease.leaseId,
            fenceToken: job.lease.fenceToken,
            inputIds: [...inputIds],
          }, signal)).downloads,
        } : {}),
        progress: (progress) => forward({
          schema: 'simforge.render-progress/v1', event: 'stage.progress', stage: 'downloading', unit: 'items',
          jobId: job.jobId, attempt: job.attempt, sequence: 0, timestamp: new Date().toISOString(),
          ...progress,
        }),
      },
    );
    store.setMode('job-running');
    const budgetMs = Number(process.env.SIMFORGE_MAX_JOB_EXECUTION_MS ?? config.maxJobExecutionMs);
    budgetTimer = setTimeout(() => {
      state.controller.abort(Object.assign(new Error(`render.job_budget_exceeded: execution exceeded ${Math.round(budgetMs / 60_000)} min after inputs were ready`), { code: 'native_job_budget_exceeded', retryable: true }));
    }, budgetMs);
    budgetTimer.unref();
    await stageStarted('preparing');
    const containerIdentity = configuredContainerIdentity(config);
    if (containerIdentity) await chownWorkspace(workspace, containerIdentity);
    let gpuMemory: GpuMemory | null = null;
    if (engine.capabilities.requiresGpu) {
      gpuLock = await acquireGpuJobLock(config.gpuLockPath, job.jobId, {
        signal: state.controller.signal,
        // A lock naming one of this worker's own earlier jobs is a leftover.
        isJobActive: async (jobId) => jobId === job.jobId || !(await ownPastJob(config.scratchDir, jobId)),
        onWait: (_owner, wait) => console.error(JSON.stringify({ event: 'gpu.lock_wait', ...wait })),
      });
      // Measured while holding the lock: co-tenant renders are excluded, their idle residency is not.
      gpuMemory = await probeGpuMemory();
      if (gpuMemory) console.error(JSON.stringify({ event: 'gpu.memory', jobId: job.jobId, ...gpuMemory }));
    }
    const manifest = RenderArtifactManifestSchema.parse(await engine.execute({
      jobId: job.jobId,
      attempt: job.attempt,
      intent: job.intent,
      intentSha256: job.intentSha256,
      executionPackageControlSha256: job.executionPackageControlSha256,
      schedules: createFixedSchedules(job.intent),
      inputs,
      workspace,
      signal: state.controller.signal,
      reportProgress: forward,
      ...(gpuMemory ? { gpuMemory } : {}),
      controlFeatures: new Set(job.controlFeatures ?? []),
    }));
    if (manifest.intentSha256 !== job.intentSha256) throw new Error('engine manifest intentSha256 does not match claimed intent');
    for (const warning of engineWarningRecords(manifest, job)) await forward(warning);

    // Hash + reserve + upload artifacts through a small worker pool: large
    // sensor archives and videos otherwise serialize behind one another. The
    // completion manifest preserves engine artifact order by index.
    const completed: CompletedArtifact[] = new Array<CompletedArtifact>(manifest.artifacts.length);
    await stageStarted('uploading');
    let uploadedArtifacts = 0;
    if (manifest.artifacts.length > 0) await forward({
      schema: 'simforge.render-progress/v1', event: 'stage.progress', stage: 'uploading',
      completed: 0, total: manifest.artifacts.length, unit: 'items',
      jobId: job.jobId, attempt: job.attempt, sequence: 0, timestamp: new Date().toISOString(),
    });
    let nextArtifactIndex = 0;
    const uploadOne = async (): Promise<void> => {
      while (true) {
        const index = nextArtifactIndex;
        nextArtifactIndex += 1;
        if (index >= manifest.artifacts.length) return;
        const artifact = manifest.artifacts[index]!;
        const absolutePath = resolve(workspace, artifact.relativePath);
        if (absolutePath !== workspace && !absolutePath.startsWith(`${workspace}/`)) throw new Error(`artifact escapes workspace: ${artifact.relativePath}`);
        const digest = await hashFile(absolutePath);
        if (digest.sha256 !== artifact.sha256 || digest.sizeBytes !== artifact.sizeBytes) {
          throw new Error(`artifact integrity mismatch for ${artifact.relativePath}`);
        }
        const reservation = await withBoundedRetry('artifact reservation', config.retries, state.controller.signal, () => transport.reserveArtifact({
          schema: RENDER_WORKER_CONTROL_V2_SCHEMA,
          type: 'artifact.reserve',
          leaseId: job.lease.leaseId,
          fenceToken: job.lease.fenceToken,
          identity: ArtifactIdentitySchema.parse(artifact.identity),
          sha256: artifact.sha256,
          sizeBytes: artifact.sizeBytes,
          mediaType: artifact.mediaType,
        }, state.controller.signal));
        await withBoundedRetry('artifact upload', config.retries, state.controller.signal, () => uploadFile(
          reservation.upload.url,
          reservation.upload.headers,
          absolutePath,
          state.controller.signal,
        ));
        completed[index] = {
          artifactId: reservation.artifactId,
          identity: artifact.identity,
          sha256: artifact.sha256,
          sizeBytes: artifact.sizeBytes,
          mediaType: artifact.mediaType,
        };
        uploadedArtifacts += 1;
        await forward({
          schema: 'simforge.render-progress/v1', event: 'stage.progress', stage: 'uploading',
          completed: uploadedArtifacts, total: manifest.artifacts.length, unit: 'items',
          jobId: job.jobId, attempt: job.attempt, sequence: 0, timestamp: new Date().toISOString(),
        });
      }
    };
    await Promise.all(Array.from(
      { length: Math.max(1, Math.min(config.uploadConcurrency, manifest.artifacts.length)) },
      uploadOne,
    ));
    if (completed.length === 0) throw new Error('engine produced no artifacts');
    await stageStarted('finalizing');
    await flushProgress();
    // No engine warning is silently discarded: resend any the best-effort
    // forwarder could not deliver, and fail the job if they still cannot be.
    for (const warning of progress.undeliveredWarnings()) {
      try {
        await sendProgress(warning);
      } catch (error) {
        throw new Error(`engine warning ${(warning as { code: string }).code} could not be delivered to the control plane: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
    }
    state.heartbeatController.abort(new Error('render complete; stop heartbeats before fencing completion'));
    await heartbeat;
    if (state.heartbeatError) throw state.heartbeatError;
    try {
      await withBoundedRetry('fenced completion', config.retries, state.controller.signal, () => transport.complete({
        schema: RENDER_WORKER_CONTROL_V2_SCHEMA,
        type: 'job.complete',
        leaseId: job.lease.leaseId,
        fenceToken: job.lease.fenceToken,
        intentSha256: job.intentSha256,
        manifest: { artifacts: completed },
      }, state.controller.signal), { retryable: (error) => completionRefusal(error) === null });
    } catch (error) {
      const refusal = completionRefusal(error);
      if (!refusal) throw error;
      failedByControlPlane = refusal.jobFailed;
      throw new CompletionRefusedError(refusal);
    }
    outcome = 'succeeded';
  } catch (error) {
    state.heartbeatController.abort(new Error('render failed; stop heartbeats before fenced failure'));
    await heartbeat.catch(() => undefined);
    const effectiveError = state.heartbeatError
      ?? (state.controller.signal.aborted ? state.controller.signal.reason : error);
    const failure = failureOf(effectiveError);
    const reportingSignal = AbortSignal.timeout(30_000);
    if (failure.code === 'render.canceled') {
      const canceled = RenderProgressRecordSchema.parse({
        schema: 'simforge.render-progress/v1',
        event: 'job.canceled',
        jobId: job.jobId,
        attempt: job.attempt,
        sequence: state.progressSequence,
        timestamp: new Date().toISOString(),
        reason: failure.message,
      });
      await withBoundedRetry('cancellation progress', config.retries, reportingSignal, () => transport.progress({
        schema: RENDER_WORKER_CONTROL_V2_SCHEMA,
        type: 'lease.progress',
        leaseId: job.lease.leaseId,
        fenceToken: job.lease.fenceToken,
        records: [canceled],
      }, reportingSignal)).catch(() => undefined);
    }
    if (failedByControlPlane) {
      // The control plane recorded this failure itself when it refused the
      // evidence, and released the lease: a second report would only 409.
      console.error(JSON.stringify({ event: 'job.failed_by_control_plane', jobId: job.jobId, failure }));
    } else {
      try {
        await withBoundedRetry('fenced failure', config.retries, reportingSignal, () => transport.fail({
          schema: RENDER_WORKER_CONTROL_V2_SCHEMA,
          type: 'job.fail',
          leaseId: job.lease.leaseId,
          fenceToken: job.lease.fenceToken,
          intentSha256: job.intentSha256,
          failure,
        }, reportingSignal));
      } catch (reportError) {
        // The lease expires and the control plane requeues the job; exiting the
        // worker would only add a restart on top.
        console.error(JSON.stringify({
          event: 'job.fail_report_failed',
          jobId: job.jobId,
          failure,
          error: reportError instanceof Error ? reportError.message : String(reportError),
        }));
      }
    }
  } finally {
    clearTimeout(budgetTimer);
    state.heartbeatController.abort(new Error('job finalized'));
    state.controller.abort(new RenderCanceledError('job finalized'));
    await heartbeat.catch(() => undefined);
    await gpuLock?.release();
    finishedJobs.add(job.jobId);
    store.setMode('idle');
    // A succeeded job's outputs are uploaded and its inputs live in the
    // cache: the workspace is garbage. Failed ones are kept for debugging
    // and swept after `workspaceRetentionMs`.
    if (outcome === 'succeeded') await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  }
  return outcome;
}

/** Deletes workspaces (and claim files) of finished jobs older than the retention. */
export async function sweepScratch(scratchDir: string, retentionMs: number, activeJobId?: string): Promise<number> {
  let names: string[];
  try {
    names = await readdir(scratchDir);
  } catch {
    return 0;
  }
  let removed = 0;
  const now = Date.now();
  for (const name of names) {
    if (!/^(usrj|usj|job)[_A-Za-z0-9-]*(-\d+|-claim\.json)$/.test(name)) continue;
    if (activeJobId && name.startsWith(`${activeJobId}-`)) continue;
    const entry = join(scratchDir, name);
    try {
      if (now - (await stat(entry)).mtimeMs < retentionMs) continue;
      await rm(entry, { recursive: true, force: true });
      removed += 1;
    } catch {
      // Raced with another sweeper.
    }
  }
  return removed;
}

export async function runRenderWorker(
  config: RenderWorkerConfig,
  transport: RenderControlTransport,
  health: WorkerHealth,
  drainSignal: AbortSignal,
): Promise<void> {
  await mkdir(config.scratchDir, { recursive: true });
  await mkdir(config.cacheDir, { recursive: true });
  const engine = await loadConfiguredEngine(config);
  const envConcurrency = process.env.SIMFORGE_INPUT_DOWNLOAD_CONCURRENCY ? Number(process.env.SIMFORGE_INPUT_DOWNLOAD_CONCURRENCY) : undefined;
  const jobConcurrency = config.cache.jobConcurrency ?? envConcurrency ?? 16;
  if (!Number.isInteger(jobConcurrency) || jobConcurrency < 1 || jobConcurrency > 128) throw new Error('input download concurrency must be an integer from 1 to 128');
  const store = new BlobStore({
    root: config.cacheDir,
    jobConcurrency,
    prewarmIdleConcurrency: config.cache.prewarm.idleConcurrency,
    prewarmBusyConcurrency: config.cache.prewarm.busyConcurrency,
    prewarmBusyBytesPerSecond: config.cache.prewarm.busyBytesPerSecond,
    instanceTag: config.workerId,
  });
  // Nothing runs in this process yet: a GPU lock left by this worker's
  // previous process (crash, restart, redeploy) is released now instead of
  // failing the next job, whatever its PID namespace said.
  const staleLock = await clearStaleGpuLock(config.gpuLockPath, { isJobActive: async (jobId) => !(await ownPastJob(config.scratchDir, jobId)) });
  if (staleLock) console.error(JSON.stringify({ event: 'gpu.lock_stale_removed', path: config.gpuLockPath, reason: staleLock, at: 'startup' }));
  const migrated = await store.migrateLegacyLayout();
  const swept = await sweepScratch(config.scratchDir, config.workspaceRetentionMs);
  console.error(JSON.stringify({ event: 'cache.ready', root: config.cacheDir, migratedLegacyBlobs: migrated, sweptWorkspaces: swept, jobConcurrency }));
  const operationSignal = new AbortController().signal;
  const labels = {
    ...config.labels,
    // Leases may then carry `controlFeatures`; without it the engine writes baseline outputs only.
    [WORKER_CONTROL_FEATURES_LABEL]: WORKER_CONTROL_FEATURES_V1,
    // Prewarm manifests may then carry `derivativesSha256` (Prewarmer keys its member cache by it).
    [WORKER_PREWARM_FEATURES_LABEL]: WORKER_PREWARM_FEATURES.join(','),
    ...(transport.inputUrls ? { [WORKER_INPUT_URLS_LABEL]: WORKER_INPUT_URLS_BATCH_V1 } : {}),
  };
  const registration = await withBoundedRetry('worker registration', config.retries, operationSignal, () => transport.register({
    schema: RENDER_WORKER_CONTROL_V2_SCHEMA,
    type: 'worker.register',
    workerId: config.workerId,
    instanceId: config.instanceId,
    engine: engine.capabilities,
    labels,
  }, operationSignal));
  health.set('ready');
  const markDraining = (): void => health.set('draining');
  drainSignal.addEventListener('abort', markDraining, { once: true });

  // Background prewarm of every published native map closure (native engines
  // only: a CARLA world ships its maps in the image). It accepts jobs throughout.
  const prewarmEnv = process.env.SIMFORGE_PREWARM?.trim();
  const budgetEnv = process.env.SIMFORGE_CACHE_BUDGET_BYTES ? Number(process.env.SIMFORGE_CACHE_BUDGET_BYTES) : undefined;
  const prewarmer = engine.capabilities.backend === 'native'
    ? new Prewarmer(store, transport, {
      enabled: prewarmEnv === undefined ? config.cache.prewarm.enabled : prewarmEnv !== '0',
      intervalMs: config.cache.prewarm.intervalMs,
      pollMs: config.cache.prewarm.pollMs,
      budgetBytes: budgetEnv !== undefined && Number.isSafeInteger(budgetEnv) && budgetEnv >= 0 ? budgetEnv : config.cache.budgetBytes,
      minFreeBytes: config.cache.minFreeBytes,
      unwantedGraceMs: config.cache.unwantedGraceMs,
      actorAssets: true,
    }, () => registration.registrationId)
    : undefined;
  const prewarmStop = new AbortController();
  let lastGpuProbe = 0;
  const statusTimer = setInterval(() => {
    if (engine.capabilities.requiresGpu && Date.now() - lastGpuProbe > 30_000) {
      lastGpuProbe = Date.now();
      void probeGpuMemory().then((gpu) => {
        prewarmer?.setGpu(gpu);
        if (gpu) health.setStatus?.('gpu', gpu);
      });
    }
    health.setStatus?.('cache', prewarmer?.status() ?? { state: 'disabled' });
    health.setStatus?.('transfers', store.stats());
    // Waiting for the GPU names the holder, why its lock counts as live, and for how long.
    health.setStatus?.('gpuLock', gpuLockStatus(config.gpuLockPath));
  }, 2000);
  statusTimer.unref();
  const prewarmRun = prewarmer?.run(AbortSignal.any([drainSignal, prewarmStop.signal])).catch((error: unknown) => {
    console.error(JSON.stringify({ event: 'prewarm.stopped', error: error instanceof Error ? error.message : String(error) }));
  });
  let lastSweep = Date.now();

  try {
    while (!drainSignal.aborted) {
      const claim = await withBoundedRetry('job claim', config.retries, drainSignal, () => transport.claim({
        schema: RENDER_WORKER_CONTROL_V2_SCHEMA,
        type: 'job.claim',
        registrationId: registration.registrationId,
      }, drainSignal));
      if (claim.type === 'job.none') {
        await new Promise<void>((resolveDelay) => {
          const finish = (): void => {
            drainSignal.removeEventListener('abort', abort);
            resolveDelay();
          };
          const timer = setTimeout(finish, claim.retryAfterMs);
          const abort = (): void => {
            clearTimeout(timer);
            resolveDelay();
          };
          timer.unref();
          drainSignal.addEventListener('abort', abort, { once: true });
        });
        continue;
      }
      health.set('busy', claim.jobId);
      await executeClaim(config, transport, engine, claim, registration.heartbeatIntervalMs, store, prewarmer);
      if (!drainSignal.aborted) health.set('ready');
      if (Date.now() - lastSweep > 3_600_000) {
        lastSweep = Date.now();
        await sweepScratch(config.scratchDir, config.workspaceRetentionMs).catch(() => 0);
      }
    }
  } finally {
    prewarmStop.abort();
    clearInterval(statusTimer);
    await prewarmRun;
    health.set('draining');
    drainSignal.removeEventListener('abort', markDraining);
    const drainRequestSignal = AbortSignal.timeout(30_000);
    await withBoundedRetry('worker drain', config.retries, drainRequestSignal, () => transport.drain({
      schema: RENDER_WORKER_CONTROL_V2_SCHEMA,
      type: 'worker.drain',
      registrationId: registration.registrationId,
    }, drainRequestSignal)).catch(() => undefined);
    await engine.close?.();
    await transport.close?.();
  }
}
