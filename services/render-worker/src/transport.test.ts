import { readdir } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RENDER_WORKER_CONTROL_V2_SCHEMA } from '@simforge-oss/render';
import type { RenderIntentV1 } from '@simforge-oss/scenario';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRenderControlTransport, type RenderControlTransport } from './transport.js';

const HEX = (fill: string): string => fill.repeat(64);
const WORKER_NODE_ID = 'simforge-render-vast-3090-1';
const JOB_ID = 'usrj_transport';
const LEASE_ID = 'uslease_transport';
const FENCE_TOKEN = 'f'.repeat(64);
const TOKEN = 'dev-render-worker-token';

const INTENT: RenderIntentV1 = {
  schema: 'simforge.render-intent/v1',
  intentId: 'usri_transport',
  executionPackage: { id: 'usepkg_transport', sourceInputDigest: HEX('e') },
  scenarioRevision: {
    revisionId: 'usrev_transport',
    scenarioSha256: HEX('e'),
    openScenario: { sha256: HEX('c'), sizeBytes: 1024 },
    map: { mapId: 'map-1', revisionId: 'usmapv_1', sha256: HEX('f') },
  },
  sensorHosts: [{ sourceId: 'ego-front', actorId: 'ego', vehicleAsset: { catalogAssetId: 'vehicle.sedan' } }],
  renderSpec: {
    schema: 'simforge.render-spec/v3',
    sources: [{
      actorId: 'ego',
      sensorId: 'front',
      outputName: 'ego-front',
      modality: 'rgb',
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
  assets: [{ assetId: 'map.tile.000000', kind: 'map', sha256: HEX('9'), sizeBytes: 2048 }],
  seed: 7,
} as RenderIntentV1;

/**
 * Every `route.ts` the Studio app actually serves under the internal worker
 * surface, as request paths. The transport is only useful if it addresses
 * these; the previous `/v2/jobs/claim` family matched nothing here.
 */
async function checkedInRoutePaths(): Promise<string[]> {
  const root = fileURLToPath(new URL('../../../studio/app/api/simforge/internal', import.meta.url));
  const paths: string[] = [];
  const walk = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) await walk(join(directory, entry.name), `${prefix}/${entry.name}`);
      else if (entry.name === 'route.ts') paths.push(`/api/simforge/internal${prefix}`);
    }
  };
  await walk(root, '');
  return paths;
}

type Recorded = { method: string; path: string; workerNodeIdHeader: string | undefined; authorization: string | undefined };

function respond(path: string): unknown {
  if (path.endsWith('/workers/register')) {
    return {
      schema: RENDER_WORKER_CONTROL_V2_SCHEMA,
      type: 'worker.registered',
      registrationId: 'uswr_transport',
      heartbeatIntervalMs: 30_000,
    };
  }
  if (path.endsWith('/render-jobs/lease')) {
    return {
      schema: RENDER_WORKER_CONTROL_V2_SCHEMA,
      type: 'job.leased',
      jobId: JOB_ID,
      attempt: 1,
      lease: { leaseId: LEASE_ID, fenceToken: FENCE_TOKEN, expiresAt: new Date(Date.now() + 900_000).toISOString() },
      intent: INTENT,
      intentSha256: HEX('a'),
      executionPackageControlSha256: HEX('b'),
      inputs: [],
    };
  }
  if (path.endsWith('/heartbeat')) {
    return {
      schema: RENDER_WORKER_CONTROL_V2_SCHEMA,
      type: 'lease.heartbeat-ack',
      leaseExpiresAt: new Date(Date.now() + 900_000).toISOString(),
      cancelRequested: false,
      cancelReason: null,
    };
  }
  if (path.endsWith('/events')) {
    return { schema: RENDER_WORKER_CONTROL_V2_SCHEMA, type: 'lease.progress-ack', acceptedThroughSequence: 0 };
  }
  if (path.endsWith('/artifacts')) {
    return {
      schema: RENDER_WORKER_CONTROL_V2_SCHEMA,
      type: 'artifact.reserved',
      artifactId: 'usart_transport',
      upload: { url: 'https://dev.example.test/upload', method: 'PUT', headers: {} },
    };
  }
  if (path.endsWith('/state')) {
    return { schema: RENDER_WORKER_CONTROL_V2_SCHEMA, type: 'worker.draining' };
  }
  return { schema: RENDER_WORKER_CONTROL_V2_SCHEMA, type: 'mutation.accepted' };
}

describe('render control transport against the checked-in Studio routes', () => {
  let server: Server;
  let recorded: Recorded[];
  let transport: RenderControlTransport;

  beforeEach(async () => {
    recorded = [];
    server = createServer((request, response) => {
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      recorded.push({
        method: request.method ?? '',
        path,
        workerNodeIdHeader: request.headers['x-simforge-worker-node-id'] as string | undefined,
        authorization: request.headers.authorization,
      });
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(respond(path)));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    process.env.SIMFORGE_TEST_RENDER_WORKER_TOKEN = TOKEN;
    transport = createRenderControlTransport({
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      workerNodeId: WORKER_NODE_ID,
      tokenEnv: 'SIMFORGE_TEST_RENDER_WORKER_TOKEN',
    });
  });

  afterEach(async () => {
    delete process.env.SIMFORGE_TEST_RENDER_WORKER_TOKEN;
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });

  it('posts every lease operation to a route the app serves, carrying worker identity and token', async () => {
    const signal = AbortSignal.timeout(20_000);
    const lease = { schema: RENDER_WORKER_CONTROL_V2_SCHEMA, leaseId: LEASE_ID, fenceToken: FENCE_TOKEN } as const;

    await transport.register({
      schema: RENDER_WORKER_CONTROL_V2_SCHEMA,
      type: 'worker.register',
      workerId: WORKER_NODE_ID,
      instanceId: 'vast-instance-1',
      engine: {
        schema: 'simforge.render-engine-capabilities/v1',
        engineId: 'simforge-carla',
        engineVersion: 'a'.repeat(40),
        backend: 'carla',
        protocolVersion: 1,
        capabilities: ['sensor.rgb'],
        modalities: ['rgb'],
        limits: { maxSimultaneousSensors: 64, maxWidth: 8192, maxHeight: 8192, maxFramesPerSecond: 240 },
        requiresGpu: true,
      },
      labels: { hardwareProfile: 'rtx3090-24gb-v1' },
    }, signal);
    const claim = await transport.claim({
      schema: RENDER_WORKER_CONTROL_V2_SCHEMA,
      type: 'job.claim',
      registrationId: 'uswr_transport',
    }, signal);
    expect(claim.type).toBe('job.leased');
    await transport.heartbeat({ ...lease, type: 'lease.heartbeat', progressSequence: 0 }, signal);
    await transport.progress({
      ...lease,
      type: 'lease.progress',
      records: [{
        schema: 'simforge.render-progress/v1',
        event: 'job.started',
        jobId: JOB_ID,
        attempt: 1,
        sequence: 0,
        timestamp: new Date().toISOString(),
      }],
    }, signal);
    await transport.reserveArtifact({
      ...lease,
      type: 'artifact.reserve',
      identity: { role: 'manifest', actorId: null, sensorId: null, modality: null },
      sha256: HEX('d'),
      sizeBytes: 12,
      mediaType: 'application/json',
    }, signal);
    await transport.complete({
      ...lease,
      type: 'job.complete',
      intentSha256: HEX('a'),
      manifest: {
        artifacts: [{
          artifactId: 'usart_transport',
          identity: { role: 'manifest', actorId: null, sensorId: null, modality: null },
          sha256: HEX('d'),
          sizeBytes: 12,
          mediaType: 'application/json',
        }],
      },
    }, signal);
    await transport.drain({
      schema: RENDER_WORKER_CONTROL_V2_SCHEMA,
      type: 'worker.drain',
      registrationId: 'uswr_transport',
    }, signal);

    expect(recorded.map((entry) => entry.path)).toEqual([
      '/api/simforge/internal/workers/register',
      '/api/simforge/internal/render-jobs/lease',
      `/api/simforge/internal/render-jobs/${JOB_ID}/heartbeat`,
      `/api/simforge/internal/render-jobs/${JOB_ID}/events`,
      `/api/simforge/internal/render-jobs/${JOB_ID}/artifacts`,
      `/api/simforge/internal/render-jobs/${JOB_ID}/complete`,
      `/api/simforge/internal/workers/${WORKER_NODE_ID}/state`,
    ]);
    // Every request must be POST and must carry both credentials: the token
    // alone answers worker_unauthorized without the node-id header.
    for (const entry of recorded) {
      expect(entry.method).toBe('POST');
      expect(entry.workerNodeIdHeader).toBe(WORKER_NODE_ID);
      expect(entry.authorization).toBe(`Bearer ${TOKEN}`);
    }

    const served = await checkedInRoutePaths();
    const templated = recorded.map((entry) => entry.path
      .replace(`/render-jobs/${JOB_ID}/`, '/render-jobs/[jobId]/')
      .replace(`/workers/${WORKER_NODE_ID}/`, '/workers/[workerNodeId]/'));
    expect(served).toEqual(expect.arrayContaining(templated));
  });

  it('reports a failing fence path instead of a bare status code', async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    server = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        response.writeHead(409, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'lease_invalid_or_expired' }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const rejected = createRenderControlTransport({
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      workerNodeId: WORKER_NODE_ID,
    });
    await expect(rejected.claim({
      schema: RENDER_WORKER_CONTROL_V2_SCHEMA,
      type: 'job.claim',
      registrationId: 'uswr_transport',
    }, AbortSignal.timeout(20_000))).rejects.toThrow(
      /render-jobs\/lease returned 409: .*lease_invalid_or_expired/,
    );
  });
});
