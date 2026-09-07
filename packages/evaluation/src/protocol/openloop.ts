/**
 * Open-loop evaluation contracts shared by the desktop host, the web portal
 * and the cloud worker: `simforge.openloop-params/v2` (what to run) and
 * `simforge.openloop-result/v1` (what came back).
 *
 * Semantics the schemas enforce rather than document:
 *
 * - Prediction is not scored evaluation. An item without a reference future
 *   carries `reference.kind: 'none'` and no metrics; `scored` on the run is
 *   false unless at least one item was scored against a real reference.
 * - A reference trajectory produced by an authored scenario or a reference
 *   policy is labelled as such and never as human ground truth.
 * - Missing driving inputs produce a typed refusal listing exactly which
 *   fields were required. Nothing is fabricated: no synthetic camera views,
 *   no assumed ego history, no invented calibration.
 * - `exploratory: true` runs (user-typed assumptions) can never carry metrics
 *   and can never be promoted or compared.
 * - Every trajectory is self-describing: `frame`, `convention`, `dtS`,
 *   `horizonS`. Image-space projection is a presentation concern and requires
 *   real calibration, which lives in `projection`.
 */

import { z } from 'zod';

import type { TrajectoryMetrics } from './metrics.js';
import { OpenloopInputSchema, type OpenloopParams } from './params.js';

export * from './params.js';

export const OPENLOOP_RESULT_SCHEMA = 'simforge.openloop-result/v1';

export const ReferenceSchema = z.object({
  /** `dataset` = recorded human future, `authored`/`reference-policy` are not human GT. */
  kind: z.enum(['dataset', 'authored', 'reference-policy', 'recorded-replay', 'none']),
  frame: z.string().default('ego@t0'),
  convention: z.literal('FLU').default('FLU'),
  dtS: z.number().positive().default(0.1),
  points: z.array(z.array(z.number())).default([]),
});

export const ProjectionSchema = z.object({
  cameraId: z.number().int().min(0).max(6),
  K: z.array(z.array(z.number())).length(3),
  distortion: z.object({ model: z.string(), coeffs: z.array(z.number()) }),
  extrinsicsRigFromCamera: z.array(z.array(z.number())).length(4),
  imageSize: z.tuple([z.number().int().positive(), z.number().int().positive()]),
  timestampsUs: z.array(z.number()).default([]),
});

export const OpenloopItemSchema = z.object({
  index: z.number().int().nonnegative(),
  itemId: z.string().min(1),
  status: z.enum(['ok', 'refused', 'error']),
  input: OpenloopInputSchema,
  /** Trajectory geometry; self-describing, metric, never image-space. */
  frame: z.string().default('ego@t0'),
  convention: z.literal('FLU').default('FLU'),
  dtS: z.number().positive().default(0.1),
  horizonS: z.number().positive().default(6.4),
  /** `[sample][waypoint][x, y, z]` in `frame`. */
  points: z.array(z.array(z.array(z.number()))).default([]),
  rotations: z.array(z.array(z.array(z.array(z.number())))).nullable().default(null),
  reasoning: z.array(z.string().nullable()).default([]),
  text: z.string().nullable().default(null),
  fields: z.record(z.string(), z.unknown()).nullable().default(null),
  reference: ReferenceSchema.default({ kind: 'none' }),
  projection: ProjectionSchema.nullable().default(null),
  metrics: z.record(z.string(), z.unknown()).nullable().default(null),
  latencyMs: z.number().nonnegative().nullable().default(null),
  refusal: z
    .object({
      code: z.enum(REFUSAL_CODES),
      message: z.string(),
      missingFields: z.array(z.string()).default([]),
      requiredCameras: z.array(z.number().int()).nullable().default(null),
    })
    .nullable()
    .default(null),
  error: z.object({ code: z.string(), message: z.string() }).nullable().default(null),
  coldStart: z.boolean().default(false),
  /**
   * The engine's `rng_provenance` for THIS item, verbatim. It carries the
   * upstream task name (`upstream_task`) for text tasks, so a result document
   * names the upstream code that actually ran without anyone re-deriving it
   * from the job's task spelling.
   */
  rngProvenance: z.record(z.string(), z.unknown()).nullable().default(null),
});
export type OpenloopItem = z.infer<typeof OpenloopItemSchema>;

export const OpenloopResultSchema = z.object({
  schema: z.literal(OPENLOOP_RESULT_SCHEMA).default(OPENLOOP_RESULT_SCHEMA),
  runId: z.string().min(1),
  attemptId: z.string().min(1).nullable().default(null),
  task: z.enum(['act', 'text']),
  exploratory: z.boolean().default(false),
  items: z.array(OpenloopItemSchema),
  aggregate: z.object({
    itemCount: z.number().int().nonnegative(),
    okItems: z.number().int().nonnegative(),
    refusedItems: z.number().int().nonnegative(),
    failedItems: z.number().int().nonnegative(),
    scoredItems: z.record(z.string(), z.number()).default({}),
    minADE: z.record(z.string(), z.number()).default({}),
    minFDE: z.record(z.string(), z.number()).default({}),
    sampleCounts: z.array(z.number().int()).default([]),
    latencyMs: z.object({ p50: z.number(), p95: z.number(), max: z.number() }).nullable().default(null),
  }),
  provenance: z.record(z.string(), z.unknown()),
});
export type OpenloopResult = z.infer<typeof OpenloopResultSchema>;

/** Latency percentiles over the observed per-item latencies. */
export function latencySummary(samples: readonly number[]): { p50: number; p95: number; max: number } | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]!;
  return { p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1]! };
}

/**
 * Roll per-item metrics into the result aggregate.
 *
 * Only items with `status: 'ok'` and a real (non-`none`) reference contribute
 * to `minADE`/`minFDE`; refused and failed items are counted separately so a
 * consumer can never read a mean that quietly excluded failures.
 */
export function buildAggregate(
  items: readonly OpenloopItem[],
  metricsByItem: ReadonlyMap<number, TrajectoryMetrics>,
): OpenloopResult['aggregate'] {
  const adeSum: Record<string, number> = {};
  const fdeSum: Record<string, number> = {};
  const counts: Record<string, number> = {};
  const sampleCounts = new Set<number>();
  const latencies: number[] = [];
  let okItems = 0;
  let refusedItems = 0;
  let failedItems = 0;

  for (const item of items) {
    if (item.status === 'ok') okItems += 1;
    else if (item.status === 'refused') refusedItems += 1;
    else failedItems += 1;
    if (item.latencyMs !== null) latencies.push(item.latencyMs);
    const metrics = metricsByItem.get(item.index);
    if (!metrics || item.status !== 'ok' || item.reference.kind === 'none') continue;
    sampleCounts.add(metrics.samples);
    for (const [key, horizon] of Object.entries(metrics.horizons)) {
      adeSum[key] = (adeSum[key] ?? 0) + horizon.minAdeM;
      fdeSum[key] = (fdeSum[key] ?? 0) + horizon.minFdeM;
      counts[key] = (counts[key] ?? 0) + 1;
    }
  }

  const minADE: Record<string, number> = {};
  const minFDE: Record<string, number> = {};
  for (const [key, count] of Object.entries(counts)) {
    minADE[key] = adeSum[key]! / count;
    minFDE[key] = fdeSum[key]! / count;
  }
  return {
    itemCount: items.length,
    okItems,
    refusedItems,
    failedItems,
    scoredItems: counts,
    minADE,
    minFDE,
    sampleCounts: [...sampleCounts].sort((a, b) => a - b),
    latencyMs: latencySummary(latencies),
  };
}

/**
 * Whether a completed open-loop run may present scores at all.
 *
 * True only when at least one item was compared to a real reference future
 * and the run is not exploratory. This is the single gate both hosts read.
 */
export function isScoredRun(result: Pick<OpenloopResult, 'exploratory' | 'aggregate' | 'task'>): boolean {
  if (result.exploratory || result.task === 'text') return false;
  return Object.values(result.aggregate.scoredItems).some((count) => count > 0);
}
