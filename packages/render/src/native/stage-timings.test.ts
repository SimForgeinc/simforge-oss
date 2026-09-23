import { describe, expect, it } from 'vitest';

import { parseToleratingUnknownKeys } from './evidence.js';
import { NATIVE_STAGE_TIMINGS_V1_SCHEMA, NativeStageTimingsSchema, StageSamples, splitServiceStages, summarizeStage } from './stage-timings.js';

describe('native stage timings', () => {
  it('summarises samples with nearest-rank percentiles', () => {
    expect(summarizeStage([4, 1, 3, 2])).toEqual({ count: 4, totalMs: 10, meanMs: 2.5, p50Ms: 2, p95Ms: 4, maxMs: 4 });
    expect(summarizeStage([])).toEqual({ count: 0, totalMs: 0, meanMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 });
    expect(summarizeStage([5, Number.NaN, -1]).count).toBe(1);
  });

  it('splits service stages into durations and counters and ignores junk', () => {
    const { durations, counts } = splitServiceStages({
      apply_ms: 1.5, capture_ms: 20, readiness_updates: 3, sensors_overlapped: true, bogus: 'x', negative_ms: -1,
    });
    expect(durations).toEqual({ apply: 1.5, capture: 20 });
    expect(counts).toEqual({ readiness_updates: 3, sensors_overlapped: 1 });
    expect(splitServiceStages(undefined)).toEqual({ durations: {}, counts: {} });
  });

  it('accumulates by stage in a stable key order that the schema accepts', () => {
    const samples = new StageSamples();
    samples.add('readiness', 30);
    samples.add('apply', 1);
    samples.add('readiness', 10);
    const summary = samples.summary();
    expect(Object.keys(summary)).toEqual(['apply', 'readiness']);
    expect(summary.readiness!.totalMs).toBe(40);
    expect(NativeStageTimingsSchema.parse({
      schema: NATIVE_STAGE_TIMINGS_V1_SCHEMA, ticks: 2, startupMs: { serviceStart: 12 },
      server: summary, client: {}, counters: { readiness_updates: 6 }, encoders: { cam: 'h264_nvenc' },
    }).ticks).toBe(2);
  });

  it('an older host drops `timings.stages` instead of refusing the completion', () => {
    const legacyHost = { safeParse: (input: unknown) => {
      const timings = (input as { timings: Record<string, unknown> }).timings;
      const extra = Object.keys(timings).filter((key) => key !== 'wallMs' && key !== 'serverMs');
      return extra.length === 0
        ? { success: true as const, data: input }
        : { success: false as const, error: { issues: [{ code: 'unrecognized_keys', path: ['timings'], message: 'unknown', keys: extra }] } };
    } };
    const parsed = parseToleratingUnknownKeys(legacyHost, { timings: { wallMs: 1, serverMs: 1, stages: {} } });
    expect(parsed.ignoredFields).toEqual(['timings.stages']);
  });
});
