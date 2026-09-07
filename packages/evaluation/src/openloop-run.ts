/**
 * Open-loop execution core — the one implementation both hosts use.
 *
 * The desktop model-run worker and the cloud worker CLI differ only in how
 * they reach the engine and how an item's bundle path is resolved; everything
 * that decides what is evaluated, what is refused and what is scored lives
 * here, so a local run and a remote run of the same input produce the same
 * `openloop.json`.
 *
 * Refusals are per item and never fail the batch: a clip that cannot supply
 * the model's camera set, calibration or ego history comes back as
 * `status: 'refused'` with the exact missing fields. Only a transport or
 * engine fault aborts the run.
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  buildObservation,
  buildTextObservation,
  ClipInputError,
  loadObservationBundle,
} from './protocol/clip-input.js';
import {
  cameraSetViolation,
  endpointInvoke,
  type EndpointHealth,
  type EndpointTarget,
} from './protocol/endpoint-client.js';
import { describeArtifact, type EvalArtifact, type ResultStatus } from './protocol/manifest.js';
import { trajectoryMetrics, type TrajectoryMetrics } from './protocol/metrics.js';
import {
  buildAggregate,
  OPENLOOP_RESULT_SCHEMA,
  type OpenloopItem,
  type OpenloopParams,
  type OpenloopResult,
} from './protocol/openloop.js';

const EMPTY_REFERENCE = { kind: 'none', frame: 'ego@t0', convention: 'FLU', dtS: 0.1, points: [] } as const;

export interface OpenloopRunOptions {
  readonly runId: string;
  readonly attemptId: string | null;
  readonly params: OpenloopParams;
  readonly target: EndpointTarget;
  readonly health: EndpointHealth;
  readonly outDir: string;
  /** Local observation-bundle path for one item (job role, or a host path). */
  readonly resolveInput: (item: OpenloopParams['items'][number], index: number) => string;
  readonly signal: AbortSignal;
  readonly fallbackModel?: { family: string; revision: string; quant: string };
}

export interface OpenloopRunOutcome {
  readonly status: ResultStatus;
  readonly scored: boolean;
  readonly exploratory: boolean;
  readonly result: OpenloopResult;
  readonly metrics: Record<string, unknown>;
  readonly artifacts: EvalArtifact[];
  readonly model: Record<string, unknown>;
  readonly inputKind: string;
  readonly inputDigest: string | null;
}

/** A refused item, with the geometry fields left explicitly empty. */
function refusedItem(
  index: number,
  itemId: string,
  item: OpenloopParams['items'][number],
  refusal: OpenloopItem['refusal'],
  latencyMs: number | null,
  projection: OpenloopItem['projection'],
): OpenloopItem {
  return {
    index,
    itemId,
    status: 'refused',
    input: item,
    frame: 'ego@t0',
    convention: 'FLU',
    dtS: 0.1,
    horizonS: 6.4,
    points: [],
    rotations: null,
    reasoning: [],
    text: null,
    fields: null,
    reference: { ...EMPTY_REFERENCE, points: [] },
    projection,
    metrics: null,
    latencyMs,
    refusal,
    error: null,
    coldStart: false,
  };
}

export async function executeOpenloop(options: OpenloopRunOptions): Promise<OpenloopRunOutcome> {
  const { params, health, target, outDir, signal } = options;
  const requiredCameras = health.capabilities?.cameras?.required;
  const items: OpenloopItem[] = [];
  const metricsByItem = new Map<number, TrajectoryMetrics>();
  let firstDigest: string | null = null;
  let rngProvenance: Record<string, unknown> | null = null;
  let cancelled = false;

  for (let index = 0; index < params.items.length; index += 1) {
    if (signal.aborted) {
      cancelled = true;
      break;
    }
    const item = params.items[index]!;
    const itemId = item.role ?? item.ref ?? `item-${index}`;

    let materialized;
    try {
      const bundle = await loadObservationBundle(options.resolveInput(item, index));
      firstDigest ??= bundle.digest;
      materialized =
        params.task === 'text'
          ? buildTextObservation(bundle)
          : buildObservation(bundle, {
              requiredCameras,
              variableCameras: health.capabilities?.cameras?.variable,
            });
    } catch (error) {
      if (!(error instanceof ClipInputError)) throw error;
      items.push(
        refusedItem(
          index,
          itemId,
          item,
          {
            code: error.refusal.code,
            message: error.refusal.message,
            missingFields: [...error.refusal.missingFields],
            requiredCameras: requiredCameras ? [...requiredCameras] : null,
          },
          null,
          null,
        ),
      );
      continue;
    }

    const violation = params.task === 'act' ? cameraSetViolation(health, materialized.cameraIds) : null;
    if (violation) {
      items.push(
        refusedItem(
          index,
          itemId,
          item,
          {
            code: 'camera_set_invalid',
            message: violation,
            missingFields: [],
            requiredCameras: requiredCameras ? [...requiredCameras] : null,
          },
          null,
          materialized.projection,
        ),
      );
      continue;
    }

    const startedAt = Date.now();
    const response = await endpointInvoke(target, {
      runId: options.runId,
      attemptId: options.attemptId,
      index,
      seed: params.seed,
      task: params.task,
      obs: materialized.obs,
      params: {
        num_traj_samples: params.sampling.numTrajSamples,
        top_p: params.sampling.topP,
        temperature: params.sampling.temperature,
        diffusion_steps: params.sampling.diffusionSteps,
        nav_text: params.sampling.navText,
        prompt: params.prompt,
        text_task: params.textTask,
      },
    });
    const latencyMs = Date.now() - startedAt;

    if (!response.ok) {
      const code = response.error.code;
      items.push(
        refusedItem(
          index,
          itemId,
          item,
          {
            code:
              code === 'camera_set_violation' || code === 'camera_set_invalid'
                ? 'camera_set_invalid'
                : code === 'unsupported_op'
                  ? 'unsupported_op'
                  : code === 'missing_fields' || code === 'invalid_observation'
                    ? 'missing_fields'
                    : 'input_error',
            message: response.error.message,
            missingFields: [...(response.error.fields ?? [])],
            requiredCameras: response.error.required_cameras ? [...response.error.required_cameras] : null,
          },
          latencyMs,
          materialized.projection,
        ),
      );
      continue;
    }

    const result = response.result;
    rngProvenance ??= (result.rng_provenance ?? null) as Record<string, unknown> | null;
    const dtS = result.dt_s ?? 0.1;
    const samples = (result.trajectories ?? []) as number[][][];
    const reference = materialized.reference;
    // 'auto' scores if and only if the bundle carried a real reference future.
    const scoreThisItem =
      params.task === 'act' && params.reference === 'auto' && reference.kind !== 'none' && reference.points.length > 0;
    let itemMetrics: TrajectoryMetrics | null = null;
    if (scoreThisItem && samples.length > 0) {
      itemMetrics = trajectoryMetrics(samples, reference.points, { dtS, horizonsS: params.horizonsS });
      metricsByItem.set(index, itemMetrics);
    }
    items.push({
      index,
      itemId,
      status: 'ok',
      input: item,
      frame: result.frame ?? 'ego@t0',
      convention: 'FLU',
      dtS,
      horizonS: result.horizon_s ?? dtS * (samples[0]?.length ?? 0),
      points: samples,
      rotations: (result.rotations ?? result.trajectory_rot ?? null) as number[][][][] | null,
      reasoning: [...(result.reasoning ?? [])],
      text: result.text ?? null,
      fields: result.fields ?? null,
      reference: {
        kind: reference.kind,
        frame: 'ego@t0',
        convention: 'FLU',
        dtS: reference.dtS,
        points: reference.points,
      },
      projection: materialized.projection,
      metrics: itemMetrics
        ? { horizons: itemMetrics.horizons, unavailable: itemMetrics.unavailable, samples: itemMetrics.samples }
        : null,
      latencyMs,
      refusal: null,
      error: null,
      // The clip path never replicates frames: a short window is refused in
      // buildObservation, so an accepted item always had a real 4-frame window.
      coldStart: false,
    });
  }

  const exploratory =
    params.ood.exploratory || params.ood.assumedStationaryEgo || params.ood.assumedIntrinsics !== null;
  const aggregate = buildAggregate(items, metricsByItem);
  const model = {
    family: health.family ?? options.fallbackModel?.family ?? null,
    revision: health.revision ?? options.fallbackModel?.revision ?? null,
    quant: health.quant ?? options.fallbackModel?.quant ?? null,
    checkpointDigest: health.checkpoint_digest ?? null,
    cameraProfile: health.camera_profile ?? null,
    attn: health.attn ?? null,
    torch: health.torch ?? null,
    cuda: health.cuda ?? null,
    numTrajSamples: params.sampling.numTrajSamples,
    diffusionSteps: params.sampling.diffusionSteps,
    rngProvenance,
  };

  const result: OpenloopResult = {
    schema: OPENLOOP_RESULT_SCHEMA,
    runId: options.runId,
    attemptId: options.attemptId,
    task: params.task,
    exploratory,
    items,
    aggregate,
    provenance: {
      model,
      sampling: params.sampling,
      reference: params.reference,
      horizonsS: params.horizonsS,
      seed: params.seed,
    },
  };
  await writeFile(path.join(outDir, 'openloop.json'), `${JSON.stringify(result, null, 1)}\n`, 'utf8');
  await writeFile(
    path.join(outDir, 'trajectories.json'),
    `${JSON.stringify(
      {
        schema: 'simforge.eval-trajectories/v1',
        runId: options.runId,
        items: items
          .filter((entry) => entry.status === 'ok')
          .map((entry) => ({
            itemId: entry.itemId,
            frame: entry.frame,
            convention: entry.convention,
            dtS: entry.dtS,
            horizonS: entry.horizonS,
            points: entry.points,
            rotations: entry.rotations,
            reference: entry.reference,
            projection: entry.projection,
          })),
      },
      null,
      1,
    )}\n`,
    'utf8',
  );

  const artifacts = [
    await describeArtifact(outDir, 'openloop.json', 'openloop-result', 'application/json'),
    await describeArtifact(outDir, 'trajectories.json', 'trajectories', 'application/json'),
  ];
  // Scores exist only for a non-exploratory trajectory run with a reference.
  const scored =
    !exploratory && params.task === 'act' && Object.values(aggregate.scoredItems).some((count) => count > 0);
  const status: ResultStatus = cancelled
    ? 'cancelled'
    : aggregate.okItems === params.items.length
      ? 'succeeded'
      : 'partial';
  return {
    status,
    scored,
    exploratory,
    result,
    metrics: {
      itemCount: aggregate.itemCount,
      okItems: aggregate.okItems,
      refusedItems: aggregate.refusedItems,
      failedItems: aggregate.failedItems,
      scoredItems: aggregate.scoredItems,
      minADE: aggregate.minADE,
      minFDE: aggregate.minFDE,
      sampleCounts: aggregate.sampleCounts,
      latencyMs: aggregate.latencyMs,
    },
    artifacts,
    model,
    inputKind: params.items[0]?.kind ?? 'user-clip',
    inputDigest: firstDigest,
  };
}
