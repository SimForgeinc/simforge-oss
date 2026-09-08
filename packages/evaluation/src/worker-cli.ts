#!/usr/bin/env node
/**
 * simforge-eval-worker — one evaluation job, one process.
 *
 *   simforge-eval-worker openloop --job <job.json> --out <dir>
 *   simforge-eval-worker episode  --job <job.json> --out <dir>
 *
 * The cloud worker handler writes `job.json` (`simforge.compute-job/v1`) after
 * resolving every customer artifact to a LOCAL path, and treats
 * `<out>/result.json` (`simforge.eval-result-manifest/v1`) as the sole
 * completion marker. Execution itself is the shared core (`openloop-run.ts`,
 * `episode-run.ts`) that the desktop worker also uses, so a local and a remote
 * run of the same input produce the same documents.
 *
 * Contract with the control plane:
 *
 * - `result.json` is ALWAYS written — succeeded, partial, failed or cancelled —
 *   atomically and last. A hard kill leaves none, which is the caller's failed
 *   attempt path; nothing else may be read as completion.
 * - Errors carry a shared code and an explicit `retryable` flag.
 *   `input_error`, `model_revision_mismatch` and `capability_error` are
 *   terminal: retrying cannot change them.
 * - Nothing here reaches the network: no artifact fetch, no provider call, no
 *   credential. Declared input digests are verified first, so a truncated
 *   download fails as `input_error` instead of looking like a model failure.
 * - Exit codes: 0 succeeded/partial, 130 cancelled, 2 failed.
 */

import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  executeEpisode,
  reprocessEpisode,
  type EpisodeRunOutcome,
  type ReprocessedProvenance,
} from './episode-run.js';
import { executeOpenloop } from './openloop-run.js';
import {
  ComputeJobInputSchema,
  openloopParamsOf,
  resolveJobInput,
  verifyJobInputs,
  type ComputeJobInput,
} from './protocol/compute-job.js';
import {
  APPROXIMATED_EXTRINSICS_OOD,
  PolicyEpisodeParamsSchema,
  rigHasApproximatedExtrinsics,
  type PolicyEpisodeParams,
} from './protocol/params.js';
import {
  endpointHealth,
  EndpointTransportError,
  modelIdentityMismatch,
  type EndpointHealth,
  type EndpointTarget,
} from './protocol/endpoint-client.js';
import {
  isRetryableErrorCode,
  writeResultManifest,
  type ErrorCode,
  type EvalArtifact,
  type ResultKind,
  type ResultManifest,
  type ResultStatus,
} from './protocol/manifest.js';

class JobFailure extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly fields: readonly string[] = [],
  ) {
    super(message);
    this.name = 'JobFailure';
  }
}

interface Flags {
  job?: string;
  out?: string;
  /** `reprocess` only: the retained run directory being re-read. */
  retained?: string;
  'source-commit'?: string;
}

function parseFlags(argv: readonly string[]): Flags {
  const flags: Flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const value = () => {
      const next = argv[++index];
      if (next === undefined) throw new Error(`${arg} requires a value`);
      return next;
    };
    switch (arg) {
      case '--job':
        flags.job = value();
        break;
      case '--out':
        flags.out = value();
        break;
      case '--retained':
        flags.retained = value();
        break;
      case '--source-commit':
        flags['source-commit'] = value();
        break;
      default:
        throw new Error(`unknown flag ${arg}`);
    }
  }
  return flags;
}

/** Local path of the input named by `role`, or the literal `ref`. */
function inputPath(job: ComputeJobInput, ref: string | undefined | null, role: string | undefined | null): string {
  if (role) return resolveJobInput(job, role).localPath;
  if (ref) return ref;
  throw new JobFailure('input_error', 'input has neither `role` nor `ref`');
}

function endpointTarget(job: ComputeJobInput): EndpointTarget {
  const endpoint = job.endpoint;
  if (endpoint?.httpUrl) return { url: endpoint.httpUrl, timeoutMs: endpoint.timeoutMs };
  if (endpoint?.socketPath) return { url: `unix:${endpoint.socketPath}`, timeoutMs: endpoint.timeoutMs };
  throw new JobFailure('capability_error', 'job carries no endpoint (httpUrl or socketPath) to invoke');
}

/**
 * Refuse before inference when the loaded engine is not the requested model.
 *
 * Numbers attributed to the wrong revision are worse than no numbers, and the
 * check costs one HTTP round trip against an already-loaded engine.
 */
async function requireModel(job: ComputeJobInput): Promise<EndpointHealth> {
  let health: EndpointHealth;
  try {
    health = await endpointHealth(endpointTarget(job));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new JobFailure(error instanceof EndpointTransportError ? 'internal' : 'capability_error', message);
  }
  if (health.loaded === false || health.status === 'loading') {
    throw new JobFailure('internal', `engine is not loaded yet (status ${String(health.status)})`);
  }
  const mismatch = modelIdentityMismatch(health, job.model);
  if (mismatch.length > 0) throw new JobFailure('model_revision_mismatch', mismatch.join('; '), mismatch);
  return health;
}

interface ManifestParts {
  readonly kind: ResultKind;
  readonly status: ResultStatus;
  readonly scored: boolean;
  readonly promotable: boolean;
  readonly exploratory?: boolean;
  readonly mode: string;
  readonly truncation: ResultManifest['truncation'];
  readonly metrics: Record<string, unknown>;
  readonly artifacts: readonly EvalArtifact[];
  readonly model: Record<string, unknown> | null;
  readonly inputKind: string;
  readonly inputDigest: string | null;
  /** Out-of-distribution stamps, e.g. `approximated_extrinsics`. */
  readonly ood: readonly string[];
  readonly replayContext: Record<string, unknown> | null;
  /** Set only by `reprocess`: this document re-reads a retained run. */
  readonly reprocessedFrom?: ReprocessedProvenance | null;
  readonly error: { code: ErrorCode; message: string; fields?: readonly string[] } | null;
}

/**
 * Classify a refused or failed episode for the control plane.
 *
 * A malformed or missing bundle is the CUSTOMER's input, not a capability of
 * this worker: `input_error` so the attempt is terminal and the reservation is
 * released against the right cause. A scene whose gates did not pass, a camera
 * set the family rejects, an absent frame source or a wrong model revision are
 * capability refusals — also terminal, but not the submitter's data being
 * broken. Anything else is `internal` and may be retried.
 */
function episodeErrorClass(error: { code: string; message: string }): { code: ErrorCode; message: string } {
  const code: ErrorCode = /replay_context_invalid|replay_context_missing|input_error|invalid/.test(error.code)
    ? 'input_error'
    : /camera|capability|frame_source|frame_missing|frame_window|frame_geometry|frame_decode|ego_history|replay_context|revision|unsupported/.test(
          error.code,
        )
      ? 'capability_error'
      : 'internal';
  return { code, message: error.message };
}

function stringOrNull(source: Record<string, unknown> | null, key: string): string | null {
  const value = source?.[key];
  return typeof value === 'string' ? value : null;
}

function numberOrNull(source: Record<string, unknown> | null, key: string): number | null {
  const value = source?.[key];
  return typeof value === 'number' ? value : null;
}

async function emitManifest(
  job: ComputeJobInput,
  outDir: string,
  startedAt: string,
  parts: ManifestParts,
): Promise<void> {
  const completedAt = new Date().toISOString();
  const model = parts.model;
  await writeResultManifest(outDir, {
    schema: 'simforge.eval-result-manifest/v1',
    kind: parts.kind,
    runId: job.jobId,
    attemptId: job.attemptId,
    jobId: job.jobId,
    workspaceId: job.workspaceId,
    status: parts.status,
    scored: parts.scored,
    promotable: parts.promotable,
    exploratory: parts.exploratory ?? false,
    mode: parts.mode,
    truncation: parts.truncation,
    metrics: parts.metrics,
    artifacts: [...parts.artifacts],
    provenance: {
      model: model
        ? {
            family: stringOrNull(model, 'family'),
            revision: stringOrNull(model, 'revision'),
            checkpointDigest: stringOrNull(model, 'checkpointDigest'),
            quant: stringOrNull(model, 'quant'),
            attn: stringOrNull(model, 'attn'),
            torch: stringOrNull(model, 'torch'),
            cuda: stringOrNull(model, 'cuda'),
            diffusionSteps: numberOrNull(model, 'diffusionSteps'),
            numTrajSamples: numberOrNull(model, 'numTrajSamples'),
            cameraProfile: stringOrNull(model, 'cameraProfile'),
            rngProvenance:
              model['rngProvenance'] && typeof model['rngProvenance'] === 'object'
                ? (model['rngProvenance'] as Record<string, unknown>)
                : null,
            // A seed reproduces on this host and device only.
            determinismScope: 'same-host-same-device',
          }
        : null,
      input: {
        kind: parts.inputKind,
        ref: null,
        digest: parts.inputDigest,
        ood: [...parts.ood],
        replayContext: parts.replayContext,
      },
      runtime: { worker: 'simforge-eval-worker', node: process.version, jobKind: job.kind },
      controller: {},
      compute: null,
      // The scorer decides its own version per episode: a reconstructed scene
      // is scored under v2 (footprint containment), a synthetic one under v1.
      metricVersion:
        typeof parts.metrics['metricVersion'] === 'string'
          ? `simforge.eval-metrics/${parts.metrics['metricVersion']}`
          : 'simforge.eval-metrics/v1',
      reprocessedFrom: parts.reprocessedFrom ?? null,
    },
    timing: {
      startedAt,
      completedAt,
      durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
      executionMs: null,
    },
    error: parts.error
      ? {
          code: parts.error.code,
          retryable: isRetryableErrorCode(parts.error.code),
          message: parts.error.message,
          fields: [...(parts.error.fields ?? [])],
        }
      : null,
  });
}

function episodeManifestParts(
  params: PolicyEpisodeParams,
  outcome: EpisodeRunOutcome,
  replayContextDir: string | null,
  reprocessedFrom?: ReprocessedProvenance,
): ManifestParts {
  return {
    kind: 'closedloop-episode',
    status: outcome.status,
    scored: outcome.scored,
    // Truncated, unscored and cancelled episodes never promote a model, and
    // neither does a run with no model in the loop: a reference policy or the
    // stock replay of a recorded path scores a SCENE, not a model.
    promotable: outcome.scored && outcome.status === 'succeeded' && params.runnerPolicy === 'endpoint',
    mode: params.mode,
    truncation: outcome.truncation,
    metrics: outcome.metrics,
    artifacts: outcome.artifacts,
    model: outcome.model,
    inputKind: replayContextDir ? 'replay-context' : 'scenario',
    // Rendered from an authored rig: its extrinsics are approximations of
    // the dataset rig, so the result says so and cannot be read as parity.
    ood:
      params.runnerPolicy === 'endpoint' && rigHasApproximatedExtrinsics(params.cameraProfile)
        ? [APPROXIMATED_EXTRINSICS_OOD]
        : [],
    inputDigest: null,
    replayContext:
      outcome.summary['replay_context'] && typeof outcome.summary['replay_context'] === 'object'
        ? (outcome.summary['replay_context'] as Record<string, unknown>)
        : null,
    reprocessedFrom: reprocessedFrom ?? null,
    error: outcome.error ? { ...episodeErrorClass(outcome.error), fields: [outcome.error.code] } : null,
  };
}

/**
 * Re-derive a retained episode's receipt under the current source.
 *
 * This runs no model and no simulation: it re-reads the retained trace and
 * runner summary and applies today's status mapping and scorer. The superseded
 * directory is never written to, and the new manifest carries
 * `provenance.reprocessedFrom` naming the superseded manifest's digest, the
 * trace digest it read and the source commit that produced the reading — so a
 * corrected receipt can never be mistaken for a fresh measurement.
 */
async function reprocess(argv: readonly string[]): Promise<number> {
  const flags = parseFlags(argv);
  if (!flags.job || !flags.retained || !flags.out || !flags['source-commit']) {
    process.stderr.write('reprocess requires --job, --retained, --out and --source-commit\n');
    return 2;
  }
  const startedAt = new Date().toISOString();
  const job = ComputeJobInputSchema.parse(JSON.parse(await readFile(flags.job, 'utf8')));
  const params = PolicyEpisodeParamsSchema.parse(job.params);
  const outDir = path.resolve(flags.out);
  const replayContextDir = params.replayContextRole
    ? inputPath(job, null, params.replayContextRole)
    : params.replayContext;
  const outcome = await reprocessEpisode({
    retainedDir: flags.retained,
    outDir,
    sourceCommit: flags['source-commit'],
    run: {
      runId: job.jobId,
      scoring: params.scoring,
      expectedRouteM: params.expectedRouteM,
      speedLimitMps: params.speedLimitMps,
      runner: {
        specPath: inputPath(job, params.spec, params.specRole),
        session: params.session,
        runnerPolicy: params.runnerPolicy,
        seed: params.seed,
        policySeed: params.policySeed,
        steps: params.steps,
        mode: params.mode,
        deadlineMs: params.deadlineMs,
        fallback: params.fallback,
        execution: params.execution,
        decisionHz: params.decisionHz,
        tracePath: path.join(outDir, 'trace.jsonl'),
        replayContextDir,
        endpointSocket: null,
        cameraProfile: params.cameraProfile,
        frameSource: params.frameSource,
        replanHz: params.replanHz,
        numTrajSamples: params.numTrajSamples,
        navText: params.navText,
        model: job.model,
        allowColdStart: params.allowColdStart,
        warmupPolicy: params.warmupPolicy,
        warmupSteps: params.warmupSteps,
      },
    },
  });
  await emitManifest(
    job,
    outDir,
    startedAt,
    episodeManifestParts(params, outcome, replayContextDir, outcome.reprocessedFrom),
  );
  return outcome.status === 'failed' ? 2 : 0;
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'reprocess') return reprocess(rest);
  if (command !== 'openloop' && command !== 'episode') {
    process.stderr.write(
      'usage: simforge-eval-worker <openloop|episode> --job <job.json> --out <dir>\n' +
        '       simforge-eval-worker reprocess --job <job.json> --retained <dir> --out <dir> --source-commit <sha>\n',
    );
    return 2;
  }
  const flags = parseFlags(rest);
  if (!flags.job) {
    process.stderr.write('--job is required\n');
    return 2;
  }
  const startedAt = new Date().toISOString();
  const job = ComputeJobInputSchema.parse(JSON.parse(await readFile(flags.job, 'utf8')));
  const outDir = path.resolve(flags.out ?? job.outputDir);
  await mkdir(outDir, { recursive: true });

  const controller = new AbortController();
  const stop = () => controller.abort(new Error('cancelled'));
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);

  const textKind: ResultKind = job.kind === 'alpamayo.text' ? 'text' : 'openloop';
  try {
    const problems = await verifyJobInputs(job);
    if (problems.length > 0) throw new JobFailure('input_error', problems.join('; '), problems);

    if (command === 'openloop') {
      const params = openloopParamsOf(job);
      const health = await requireModel(job);
      if (params.task === 'text' && !(health.supports ?? ['act']).includes('text')) {
        throw new JobFailure('capability_error', `${String(health.family)} does not support text tasks`);
      }
      const outcome = await executeOpenloop({
        runId: job.jobId,
        attemptId: job.attemptId,
        params,
        target: endpointTarget(job),
        health,
        outDir,
        resolveInput: (item) => inputPath(job, item.ref, item.role),
        signal: controller.signal,
        fallbackModel: job.model,
      });
      await emitManifest(job, outDir, startedAt, {
        kind: textKind,
        status: outcome.status,
        scored: outcome.scored,
        promotable: outcome.scored && outcome.status === 'succeeded',
        exploratory: outcome.exploratory,
        mode: 'openloop',
        truncation: outcome.status === 'cancelled' ? 'cancelled' : null,
        metrics: outcome.metrics,
        artifacts: outcome.artifacts,
        model: outcome.model,
        inputKind: outcome.inputKind,
        ood: [],
        inputDigest: outcome.inputDigest,
        replayContext: null,
        error: null,
      });
      return outcome.status === 'cancelled' ? 130 : 0;
    }

    const parsed = PolicyEpisodeParamsSchema.safeParse(job.params);
    if (!parsed.success) {
      throw new JobFailure(
        'input_error',
        `episode params invalid: ${parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; ')}`,
        parsed.error.issues.map((issue) => issue.path.join('.')),
      );
    }
    const params = parsed.data;
    if (params.runnerPolicy === 'endpoint' && !job.endpoint?.socketPath) {
      throw new JobFailure('capability_error', 'a model episode needs endpoint.socketPath (the msgpack policy wire)');
    }
    const specPath = inputPath(job, params.spec, params.specRole);
    const replayContextDir = params.replayContextRole
      ? inputPath(job, null, params.replayContextRole)
      : params.replayContext;
    const outcome = await executeEpisode({
      runId: job.jobId,
      outDir,
      signal: controller.signal,
      scoring: params.scoring,
      expectedRouteM: params.expectedRouteM,
      speedLimitMps: params.speedLimitMps,
      runner: {
        specPath,
        session: params.session,
        runnerPolicy: params.runnerPolicy,
        seed: params.seed,
        policySeed: params.policySeed,
        steps: params.steps,
        mode: params.mode,
        deadlineMs: params.deadlineMs,
        fallback: params.fallback,
        execution: params.execution,
        decisionHz: params.decisionHz,
        tracePath: path.join(outDir, 'trace.jsonl'),
        replayContextDir,
        endpointSocket: job.endpoint?.socketPath ?? null,
        cameraProfile: params.cameraProfile,
        frameSource: params.frameSource,
        replanHz: params.replanHz,
        numTrajSamples: params.numTrajSamples,
        navText: params.navText,
        model: job.model,
        allowColdStart: params.allowColdStart,
        warmupPolicy: params.warmupPolicy,
        warmupSteps: params.warmupSteps,
      },
    });
    await emitManifest(job, outDir, startedAt, episodeManifestParts(params, outcome, replayContextDir));
    if (outcome.status === 'cancelled') return 130;
    return outcome.status === 'failed' ? 2 : 0;
  } catch (error) {
    const failure =
      error instanceof JobFailure
        ? error
        : new JobFailure('internal', error instanceof Error ? error.message : String(error));
    // The manifest is written even here: the control plane must be able to
    // tell "this attempt failed, and why" from "no result was produced".
    await emitManifest(job, outDir, startedAt, {
      kind: command === 'episode' ? 'closedloop-episode' : textKind,
      status: controller.signal.aborted ? 'cancelled' : 'failed',
      scored: false,
      promotable: false,
      mode: command === 'episode' ? 'offline-simtime' : 'openloop',
      truncation: controller.signal.aborted ? 'cancelled' : null,
      metrics: {},
      artifacts: [],
      model: null,
      inputKind: 'unknown',
      ood: [],
      inputDigest: null,
      replayContext: null,
      error: { code: failure.code, message: failure.message, fields: failure.fields },
    });
    process.stderr.write(`${JSON.stringify({ error: failure.code, message: failure.message })}\n`);
    return controller.signal.aborted ? 130 : 2;
  }
}

process.exit(await main());
