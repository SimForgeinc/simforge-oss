import { describe, expect, it } from 'vitest';

import { RenderIntentV1Schema } from '@simforge-oss/scenario';

import {
  CONTROL_FEATURE_INTENT_RENDER_REQUEST,
  WORKER_INTENT_FEATURES,
  intentRequiredFeatures,
  workerCanParseIntent,
  workerIntentFeatures,
} from './worker-control.js';

describe('intent features (worker label intentFeatures)', () => {
  it('an intent without render needs no feature: every worker, rc.75 included, may lease it', () => {
    expect(intentRequiredFeatures({})).toEqual([]);
    expect(workerCanParseIntent(undefined, {})).toBe(true);
    expect(workerCanParseIntent(null, {})).toBe(true);
  });

  it('an intent with render is leased only to a worker that announced intent.render-request', () => {
    const training = { render: { preset: 'training' } };
    expect(intentRequiredFeatures(training)).toEqual([CONTROL_FEATURE_INTENT_RENDER_REQUEST]);
    // rc.75 workers register without the label.
    expect(workerCanParseIntent(undefined, training)).toBe(false);
    expect(workerCanParseIntent('', training)).toBe(false);
    expect(workerCanParseIntent('prewarm.derivatives', training)).toBe(false);
    expect(workerCanParseIntent(WORKER_INTENT_FEATURES.join(','), training)).toBe(true);
    expect(workerCanParseIntent(` other.feature , ${CONTROL_FEATURE_INTENT_RENDER_REQUEST} `, training)).toBe(true);
  });

  it('parses the comma-separated label', () => {
    expect([...workerIntentFeatures('a, b,,c ')]).toEqual(['a', 'b', 'c']);
    expect(workerIntentFeatures(undefined).size).toBe(0);
  });

  it('why the gate exists: a parser without `render` refuses such an intent outright', () => {
    // rc.75's RenderIntentV1Schema was a strict object without `render`; an
    // intent carrying it fails the worker's parse (hashRenderIntent), so the
    // job would fail instead of rendering. The current schema accepts it.
    const shape = RenderIntentV1Schema.shape as Record<string, unknown>;
    expect(Object.keys(shape)).toContain('render');
  });
});
