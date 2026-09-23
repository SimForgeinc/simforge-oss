import { z } from 'zod';

/**
 * Per-stage timing evidence for a native render (`timings.stages` in
 * `native-run.json`). Written only for a control plane that lists
 * `native-evidence.stage-timings`; stage names are open (a record), so a new
 * stage never needs a schema change on the host.
 */
export const NATIVE_STAGE_TIMINGS_V1_SCHEMA = 'simforge.native-stage-timings/v1' as const;

const Ms = z.number().finite().nonnegative();

export const StageSummarySchema = z.strictObject({
  count: z.number().int().nonnegative(),
  totalMs: Ms,
  meanMs: Ms,
  p50Ms: Ms,
  p95Ms: Ms,
  maxMs: Ms,
});
export type StageSummary = z.infer<typeof StageSummarySchema>;

const StageNameSchema = z.string().min(1).max(64).regex(/^[a-zA-Z][a-zA-Z0-9_.]*$/u);

export const NativeStageTimingsSchema = z.strictObject({
  schema: z.literal(NATIVE_STAGE_TIMINGS_V1_SCHEMA),
  ticks: z.number().int().nonnegative(),
  /** One-off phases before and after the tick loop, milliseconds. */
  startupMs: z.record(StageNameSchema, Ms),
  /** Per-tick service stages, from each `render_bundle` response's `stages`. */
  server: z.record(StageNameSchema, StageSummarySchema),
  /** Per-tick host stages (RPC, payload reads, rasterisation, encoder backpressure). */
  client: z.record(StageNameSchema, StageSummarySchema),
  /** Run-wide counts (readiness updates, capture attempts, lidar re-snapshots, ...). */
  counters: z.record(StageNameSchema, z.number().finite().nonnegative()),
  /** The video encoder each source used (`h264_nvenc`, `libx264`). */
  encoders: z.record(z.string().min(1).max(256), z.string().min(1).max(64)),
});
export type NativeStageTimings = z.infer<typeof NativeStageTimingsSchema>;

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index]!;
}

export function summarizeStage(samples: readonly number[]): StageSummary {
  const sorted = [...samples].filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  const totalMs = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    totalMs,
    meanMs: sorted.length === 0 ? 0 : totalMs / sorted.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted.length === 0 ? 0 : sorted[sorted.length - 1]!,
  };
}

/** Accumulates samples by stage name; `summary()` reduces them. */
export class StageSamples {
  readonly #samples = new Map<string, number[]>();

  add(stage: string, ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    let bucket = this.#samples.get(stage);
    if (!bucket) {
      bucket = [];
      this.#samples.set(stage, bucket);
    }
    bucket.push(ms);
  }

  summary(): Record<string, StageSummary> {
    return Object.fromEntries([...this.#samples].sort(([a], [b]) => a.localeCompare(b)).map(([stage, samples]) => [stage, summarizeStage(samples)]));
  }
}

/**
 * Numeric stage fields of one service response (`stages` on `render_bundle`,
 * protocol-additive: an older service omits it). Keys ending `_ms` are
 * durations; everything else is a counter.
 */
export function splitServiceStages(stages: unknown): { durations: Record<string, number>; counts: Record<string, number> } {
  const durations: Record<string, number> = {};
  const counts: Record<string, number> = {};
  if (!stages || typeof stages !== 'object' || Array.isArray(stages)) return { durations, counts };
  for (const [key, value] of Object.entries(stages as Record<string, unknown>)) {
    if (typeof value === 'boolean') {
      counts[key] = value ? 1 : 0;
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue;
    if (key.endsWith('_ms')) durations[key.slice(0, -3)] = value;
    else counts[key] = value;
  }
  return { durations, counts };
}
