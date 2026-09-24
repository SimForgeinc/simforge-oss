import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CONTROL_FEATURE_INTENT_RENDER_REQUEST,
  RENDER_WORKER_CONTROL_V2_SCHEMA,
  WORKER_INTENT_FEATURES_LABEL,
  loadBuiltinRenderEngine,
  workerCanParseIntent,
  type WorkerRegisterRequest,
} from '@simforge-oss/render';

import { RenderWorkerConfigSchema } from './config.js';
import type { WorkerHealth } from './health.js';
import type { RenderControlTransport } from './transport.js';
import { runRenderWorker } from './worker.js';

/** An engine that is never leased a job: only its capabilities matter here. */
const ENGINE_MODULE = `export async function createRenderEngine(options) {
  return { capabilities: options.capabilities, selectInputs: async () => new Set(), async execute() { throw new Error('unused'); } };
}`;

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'render-worker-intent-features-'));
  await writeFile(join(root, 'engine.mjs'), ENGINE_MODULE);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Runs the real worker loop until its first claim and returns the labels it registered with. */
async function registeredLabels(backend: 'native' | 'carla'): Promise<Record<string, string>> {
  const carla = (await loadBuiltinRenderEngine('carla', { engineVersion: '3'.repeat(40) })).capabilities;
  const capabilities = { ...carla, backend, requiresGpu: false };
  const config = RenderWorkerConfigSchema.parse({
    workerId: `worker-${backend}`,
    instanceId: 'instance-1',
    engine: { module: pathToFileURL(join(root, 'engine.mjs')).href, options: { capabilities } },
    control: { kind: 'module', module: 'unused' },
    scratchDir: join(root, 'scratch'),
    cacheDir: join(root, 'cache'),
    gpuLockPath: join(root, 'gpu.lock'),
    retries: { maxAttempts: 1, initialDelayMs: 10, maxDelayMs: 10 },
    cache: { prewarm: { enabled: false } },
  });
  const base = { schema: RENDER_WORKER_CONTROL_V2_SCHEMA } as const;
  const drain = new AbortController();
  let registered: WorkerRegisterRequest | undefined;
  const transport = {
    register: async (request: WorkerRegisterRequest) => {
      registered = request;
      return { ...base, type: 'worker.registered', registrationId: 'uswr_1', heartbeatIntervalMs: 60_000 };
    },
    claim: async () => {
      drain.abort();
      return { ...base, type: 'job.none', retryAfterMs: 10 };
    },
    drain: async () => ({ ...base, type: 'worker.draining' }),
  } as unknown as RenderControlTransport;
  const health: WorkerHealth = { set: () => undefined, close: async () => undefined };
  await runRenderWorker(config, transport, health, drain.signal);
  return registered!.labels;
}

describe('intent features: a worker is leased only intents it can parse and honor', () => {
  it('a native worker announces intent.render-request; a CARLA worker does not', async () => {
    const native = await registeredLabels('native');
    expect(native[WORKER_INTENT_FEATURES_LABEL]?.split(',')).toContain(CONTROL_FEATURE_INTENT_RENDER_REQUEST);
    expect(workerCanParseIntent(native[WORKER_INTENT_FEATURES_LABEL], { render: { preset: 'training' } })).toBe(true);
    const carla = await registeredLabels('carla');
    expect(carla[WORKER_INTENT_FEATURES_LABEL]).toBeUndefined();
    expect(workerCanParseIntent(carla[WORKER_INTENT_FEATURES_LABEL], { render: { preset: 'training' } })).toBe(false);
  });
});
