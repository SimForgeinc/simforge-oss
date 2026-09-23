import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  RENDER_WORKER_CONTROL_V2_SCHEMA,
  hashRenderIntent,
  loadBuiltinRenderEngine,
  type JobCompleteRequest,
  type JobFailRequest,
  type LeaseProgressRequest,
} from '@simforge-oss/render';
import type { RenderIntentV1 } from '@simforge-oss/scenario';

import { RenderWorkerConfigSchema } from './config.js';
import type { WorkerHealth } from './health.js';
import { withBoundedRetry } from './retry.js';
import type { RenderControlTransport } from './transport.js';
import {
  CompletionRefusedError,
  completionRefusal,
  createProgressForwarder,
  engineWarningRecords,
  failureOf,
  runRenderWorker,
} from './worker.js';

const HEX = (fill: string): string => fill.repeat(64);

const INTENT = {
  schema: 'simforge.render-intent/v1',
  intentId: 'usri_evidence',
  executionPackage: { id: 'usepkg_evidence', sourceInputDigest: HEX('e') },
  scenarioRevision: {
    revisionId: 'usrev_evidence',
    scenarioSha256: HEX('e'),
    openScenario: { sha256: HEX('c'), sizeBytes: 1024 },
    map: { mapId: 'map-1', revisionId: 'usmapv_1', sha256: HEX('f') },
  },
  sensorHosts: [{ sourceId: 'ego-front', actorId: 'ego', vehicleAsset: { catalogAssetId: 'vehicle.sedan' } }],
  renderSpec: {
    schema: 'simforge.render-spec/v3',
    sources: [{
      actorId: 'ego', sensorId: 'front', outputName: 'ego-front', modality: 'rgb',
      transform: { position: { x: 1.6, y: 0, z: 1.7 }, rotation: { yawRad: 0, pitchRad: 0, rollRad: 0 } },
      attributes: { width: 320, height: 180, fps: 24, horizontalFovDeg: 90, nearM: 0.1, farM: 1_000 },
    }],
    clip: { startSeconds: 0, endSeconds: 2 },
    video: { width: 320, height: 180, fps: 24, container: 'mp4', codec: 'h264', quality: 'high' },
    artifacts: ['manifest', 'video'],
    capabilityIntent: {
      required: ['sensor.rgb', 'artifact.manifest', 'artifact.video', 'timing.fixed_step'],
      preferred: [],
      fidelity: 'review',
    },
    authoredEnvironment: { weather: 'clear', timeOfDay: 'noon', surfacePatches: [] },
  },
  assets: [{ assetId: 'usart_catalog', kind: 'catalog', sha256: HEX('9'), sizeBytes: 2048 }],
  seed: 7,
} as RenderIntentV1;

/** An engine that renders nothing: it writes a manifest and a video and returns the given warnings. */
const ENGINE_MODULE = `
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
export async function createRenderEngine(options) {
  return {
    capabilities: options.capabilities,
    selectInputs: async () => new Set(),
    async execute(context) {
      const files = [
        { identity: { role: 'manifest', actorId: null, sensorId: null, modality: null }, name: 'manifest.json', mediaType: 'application/json', body: '{}' },
        { identity: { role: 'video', actorId: 'ego', sensorId: 'front', modality: 'rgb' }, name: 'video.mp4', mediaType: 'video/mp4', body: 'video' },
      ];
      const artifacts = [];
      for (const file of files) {
        await writeFile(join(context.workspace, file.name), file.body);
        artifacts.push({
          identity: file.identity, relativePath: file.name, mediaType: file.mediaType, frameCount: null,
          sha256: createHash('sha256').update(file.body).digest('hex'), sizeBytes: Buffer.byteLength(file.body),
        });
      }
      const now = new Date().toISOString();
      return {
        schema: 'simforge.render-artifact-manifest/v1', intentSha256: context.intentSha256,
        engine: { engineId: 'fake-carla', engineVersion: '1', backend: 'carla' },
        startedAt: now, completedAt: now, artifacts, warnings: options.warnings ?? [],
      };
    },
  };
}
`;

type Behaviour = {
  warnings?: Array<{ code: string; message: string }>;
  /** Throws on every `warning` progress record. */
  refuseWarnings?: boolean;
  complete?: (request: JobCompleteRequest) => Promise<void>;
};

type Recorded = {
  progress: LeaseProgressRequest['records'];
  completes: JobCompleteRequest[];
  fails: JobFailRequest[];
};

let root: string;
let uploads: Server;
let uploadUrl: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'render-worker-evidence-'));
  await writeFile(join(root, 'engine.mjs'), ENGINE_MODULE);
  uploads = createServer((request, response) => {
    request.resume();
    request.on('end', () => response.writeHead(200).end());
  });
  await new Promise<void>((resolve) => uploads.listen(0, '127.0.0.1', resolve));
  const address = uploads.address() as { port: number };
  uploadUrl = `http://127.0.0.1:${address.port}/upload`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => uploads.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

async function runOneJob(behaviour: Behaviour): Promise<Recorded> {
  const capabilities = { ...(await loadBuiltinRenderEngine('carla', { engineVersion: '3'.repeat(40) })).capabilities, requiresGpu: false };
  const config = RenderWorkerConfigSchema.parse({
    workerId: 'worker-evidence',
    instanceId: 'instance-1',
    engine: { module: pathToFileURL(join(root, 'engine.mjs')).href, options: { capabilities, warnings: behaviour.warnings ?? [] } },
    control: { kind: 'module', module: 'unused' },
    scratchDir: join(root, 'scratch'),
    cacheDir: join(root, 'cache'),
    gpuLockPath: join(root, 'gpu.lock'),
    retries: { maxAttempts: 3, initialDelayMs: 10, maxDelayMs: 10 },
    cache: { prewarm: { enabled: false } },
  });
  const recorded: Recorded = { progress: [], completes: [], fails: [] };
  const drain = new AbortController();
  let claims = 0;
  const base = { schema: RENDER_WORKER_CONTROL_V2_SCHEMA } as const;
  const transport: RenderControlTransport = {
    register: async () => ({ ...base, type: 'worker.registered', registrationId: 'uswr_1', heartbeatIntervalMs: 60_000 }),
    claim: async () => {
      claims += 1;
      if (claims > 1) {
        drain.abort();
        return { ...base, type: 'job.none', retryAfterMs: 100 };
      }
      return {
        ...base,
        type: 'job.leased',
        jobId: 'usrj_evidence',
        attempt: 1,
        lease: { leaseId: 'uslease_1', fenceToken: 'f'.repeat(64), expiresAt: new Date(Date.now() + 900_000).toISOString() },
        intent: INTENT,
        intentSha256: hashRenderIntent(INTENT),
        executionPackageControlSha256: HEX('d'),
        inputs: [
          { inputId: 'scenario.xosc', ...INTENT.scenarioRevision.openScenario, download: { url: 'https://inputs.invalid/xosc', headers: {} } },
          { inputId: 'usart_catalog', sha256: HEX('9'), sizeBytes: 2048, download: { url: 'https://inputs.invalid/catalog', headers: {} } },
        ],
        controlFeatures: ['render-evidence.substitutions'],
      };
    },
    heartbeat: async () => ({ ...base, type: 'lease.heartbeat-ack', leaseExpiresAt: new Date(Date.now() + 900_000).toISOString(), cancelRequested: false, cancelReason: null }),
    progress: async (request) => {
      const record = request.records[0]!;
      if (behaviour.refuseWarnings && record.event === 'warning') throw new Error('render control /events returned 503: unavailable');
      recorded.progress.push(...request.records);
      return { ...base, type: 'lease.progress-ack', acceptedThroughSequence: record.sequence };
    },
    reserveArtifact: async (request) => ({
      ...base, type: 'artifact.reserved', artifactId: `usart_${request.identity.role}`,
      upload: { url: uploadUrl, method: 'PUT', headers: {} },
    }),
    complete: async (request) => {
      recorded.completes.push(request);
      await behaviour.complete?.(request);
      return { ...base, type: 'mutation.accepted' };
    },
    fail: async (request) => {
      recorded.fails.push(request);
      return { ...base, type: 'mutation.accepted' };
    },
    drain: async () => ({ ...base, type: 'worker.draining' }),
  };
  const health: WorkerHealth = { set: () => undefined, close: async () => undefined };
  await runRenderWorker(config, transport, health, drain.signal);
  return recorded;
}

const REFUSAL = (jobFailed: boolean) => new Error(`render control /api/simforge/internal/render-jobs/usrj_evidence/complete returned 409: ${JSON.stringify({
  error: 'carla_actors_dropped',
  details: { message: 'CARLA dropped 1 actor(s) it could not spawn: ped_child', retryable: false, jobFailed, failureCode: 'render.carla_actors_dropped' },
})}`);

describe('engine warnings reach the control plane', () => {
  it('forwards every warning in the engine manifest before completing', async () => {
    const recorded = await runOneJob({ warnings: [{ code: 'native_capture_clock_unsupported', message: 'frames use update-count semantics' }] });
    const warnings = recorded.progress.filter((record) => record.event === 'warning');
    expect(warnings).toEqual([expect.objectContaining({ code: 'native_capture_clock_unsupported', message: 'frames use update-count semantics' })]);
    expect(recorded.completes).toHaveLength(1);
    expect(recorded.fails).toHaveLength(0);
  });

  it('fails the job instead of completing when a warning cannot be delivered', async () => {
    const recorded = await runOneJob({ warnings: [{ code: 'native_capture_clock_unsupported', message: 'x' }], refuseWarnings: true });
    expect(recorded.completes).toHaveLength(0);
    expect(recorded.fails).toHaveLength(1);
    expect(recorded.fails[0]!.failure.message).toMatch(/engine warning native_capture_clock_unsupported could not be delivered/);
  });
});

describe('evidence refusals at completion', () => {
  it('does not retry a refusal the control plane already recorded, and does not report it again', async () => {
    const recorded = await runOneJob({ complete: async () => { throw REFUSAL(true); } });
    expect(recorded.completes).toHaveLength(1);
    expect(recorded.fails).toHaveLength(0);
  });

  it('reports a refusal the control plane could not record, non-retryable, with its code and message', async () => {
    const recorded = await runOneJob({ complete: async () => { throw REFUSAL(false); } });
    expect(recorded.completes).toHaveLength(1);
    expect(recorded.fails).toHaveLength(1);
    expect(recorded.fails[0]!.failure).toEqual({
      code: 'render.carla_actors_dropped',
      message: 'CARLA dropped 1 actor(s) it could not spawn: ped_child',
      retryable: false,
    });
  });

  it('keeps retrying a completion error that is not an evidence refusal', async () => {
    const recorded = await runOneJob({
      complete: async () => { throw new Error('render control /complete returned 409: {"error":"render_artifact_verification_failed"}'); },
    });
    expect(recorded.completes).toHaveLength(3);
    expect(recorded.fails).toHaveLength(1);
    expect(recorded.fails[0]!.failure.retryable).toBe(true);
  });
});

describe('refusal parsing', () => {
  it('reads refusals from either transport, through retry wrapping', () => {
    const simcloud = new Error(`SimCloud control /x/complete returned 409: ${JSON.stringify({ error: 'native_parity_missing', details: { retryable: false, message: 'no parity', jobFailed: true } })}`);
    expect(completionRefusal(simcloud)).toEqual({ code: 'native_parity_missing', failureCode: 'render.native_parity_missing', message: 'no parity', jobFailed: true });
    const wrapped = new Error('fenced completion failed after 4 attempts: x', { cause: REFUSAL(false) });
    expect(completionRefusal(wrapped)?.code).toBe('carla_actors_dropped');
  });

  it('ignores 409s that are not final evidence refusals', () => {
    expect(completionRefusal(new Error('returned 409: {"error":"lease_invalid_or_expired"}'))).toBeNull();
    expect(completionRefusal(new Error('returned 409: {"error":"native_diagnostics_evidence_mismatch"}'))).toBeNull();
    expect(completionRefusal(new Error('returned 409: {"error":"carla_actors_dropped","details":{"retryable":true}}'))).toBeNull();
    expect(completionRefusal(new Error('returned 409: {"error":"carla_actors_dro'))).toBeNull();
    expect(completionRefusal(new Error('returned 500: {"error":"carla_actors_dropped","details":{"retryable":false}}'))).toBeNull();
  });

  it('reports a refused completion as its render code, never retryable', () => {
    const failure = failureOf(new CompletionRefusedError(completionRefusal(REFUSAL(true))!));
    expect(failure).toEqual({ code: 'render.carla_actors_dropped', message: 'CARLA dropped 1 actor(s) it could not spawn: ped_child', retryable: false });
  });
});

describe('warning bookkeeping', () => {
  it('keeps undelivered warnings while dropping other progress', async () => {
    const forwarder = createProgressForwarder(async () => { throw new Error('down'); }, () => false, () => undefined);
    const [warning] = engineWarningRecords({ warnings: [{ code: 'w', message: 'm' }] }, { jobId: 'usrj_1', attempt: 1 });
    await forwarder.forward(warning!);
    await forwarder.forward({
      schema: 'simforge.render-progress/v1', event: 'stage.started', stage: 'uploading',
      jobId: 'usrj_1', attempt: 1, sequence: 0, timestamp: new Date().toISOString(),
    });
    await forwarder.flush();
    expect(forwarder.undeliveredWarnings()).toEqual([warning]);
  });

  it('lets a caller stop retrying an error retrying cannot change', async () => {
    let calls = 0;
    const final = new Error('final');
    await expect(withBoundedRetry('op', { maxAttempts: 4, initialDelayMs: 1, maxDelayMs: 1 }, new AbortController().signal, async () => {
      calls += 1;
      throw final;
    }, { retryable: (error) => error !== final })).rejects.toBe(final);
    expect(calls).toBe(1);
  });
});
