/**
 * `simforge render` against a host named only by `SIMFORGE_API_BASE_URL`.
 *
 * The transport is mocked — a real `node:http` server standing in for the host,
 * the same device `host-client-protocol.test.ts` uses — because what has to
 * hold is the *wire*: the method and path each verb calls, the body `submit`
 * posts, that a real response shape decodes, and that a refusal reaches stderr
 * as the host's own error code rather than a generic failure. No live dev call
 * is involved, and none of these assertions depend on one succeeding.
 */

import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { run } from '../main.js';

const TOKEN = 'test-only-control-token';

type Received = { method: string; url: string; authorization: string | undefined; body: unknown };

type Route = { status: number; body: unknown };

/** A host that answers `routes[method + ' ' + pathname]` and records every call. */
async function fakeHost(routes: Record<string, Route>) {
  const received: Received[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      received.push({
        method: request.method ?? '',
        url: request.url ?? '',
        authorization: request.headers.authorization,
        body: raw ? JSON.parse(raw) : null,
      });
      const pathname = new URL(request.url ?? '/', 'http://host').pathname;
      const route = routes[`${request.method} ${pathname}`];
      response.setHeader('content-type', 'application/json');
      if (!route) {
        response.writeHead(404).end(JSON.stringify({ error: 'no_such_route', message: `${request.method} ${pathname}` }));
        return;
      }
      response.writeHead(route.status).end(JSON.stringify(route.body));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake host did not bind a TCP port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    received,
    close() {
      server.closeAllConnections();
      server.close();
    },
  };
}

const JOB = {
  id: 'rjob_0f3a',
  revisionId: 'usrev_31b16a3f5f1049318e865848',
  executionPackageId: 'usxp_9c11',
  originRecordingJobId: null,
  mode: 'full_render',
  status: 'running',
  progress: 0.42,
  billingMode: 'free',
  estimatedCost: 0,
  renderSpec: null,
  telemetry: { wallSeconds: 12.5 },
  parityResult: null,
  parityEvidence: null,
  resourceRequest: null,
  workerAttestation: null,
  failureCode: null,
  failureDetail: null,
  createdAt: '2026-09-17T10:00:00.000Z',
  updatedAt: '2026-09-17T10:02:00.000Z',
};

const ARTIFACT = {
  id: 'uart_video_1',
  artifactKind: 'render_video',
  mediaType: 'video/mp4',
  byteLength: 52_428_800,
  sha256: 'a'.repeat(64),
  artifactState: 'available',
  relationship: null,
  renderAttemptId: 'rat_1',
  identity: { role: 'video', actorId: 'ego', sensorId: 'camera_front_wide_120fov', modality: 'rgb' },
  createdAt: '2026-09-17T10:07:00.000Z',
  verifiedAt: '2026-09-17T10:07:01.000Z',
};

const DETAIL = {
  id: JOB.id,
  revisionId: JOB.revisionId,
  executionPackageId: JOB.executionPackageId,
  executionPackageControlSha256: 'b'.repeat(64),
  renderProfileId: null,
  jobMode: 'full_render',
  jobState: 'running',
  progressPercent: 42,
  progressDetail: {
    schema: 'simforge.render-progress/v1',
    jobId: JOB.id,
    attempt: 2,
    sequence: 31,
    timestamp: '2026-09-17T10:02:00.000Z',
    event: 'stage.progress',
    stage: 'rendering',
    completed: 420,
    total: 1000,
    unit: 'frames',
  },
  rendererEngine: 'carla',
  intentSha256: 'c'.repeat(64),
  priority: 0,
  attemptCount: 2,
  maxAttempts: 3,
  failureCode: null,
  failureDetail: null,
  billingMode: 'free',
  estimatedCostCents: 0,
  renderSpecSha256: 'd'.repeat(64),
  hiddenAt: null,
  hiddenByUserId: null,
  parentRenderJobId: null,
  sourceArtifactId: null,
  modelFamily: null,
  modelConfigSha256: null,
  createdAt: JOB.createdAt,
  updatedAt: JOB.updatedAt,
  startedAt: '2026-09-17T10:00:30.000Z',
  completedAt: null,
  cancelRequestedAt: null,
  attempts: [
    {
      id: 'rat_1',
      attemptNumber: 1,
      executionPackageControlSha256: 'b'.repeat(64),
      status: 'failed',
      attemptState: 'failed',
      workerNodeId: 'vast-3090-01',
      workerClass: 'carla-render',
      runtimeVersion: '0.10.0',
      rendererEngine: 'carla',
      baseImageDigest: null,
      baseImagePlatformDigest: null,
      engineCapabilitiesSha256: null,
      imageDigest: null,
      leasedAt: '2026-09-17T10:00:10.000Z',
      startedAt: '2026-09-17T10:00:12.000Z',
      completedAt: '2026-09-17T10:00:20.000Z',
    },
    {
      id: 'rat_2',
      attemptNumber: 2,
      executionPackageControlSha256: 'b'.repeat(64),
      status: 'running',
      attemptState: 'running',
      workerNodeId: 'vast-3090-02',
      workerClass: 'carla-render',
      runtimeVersion: '0.10.0',
      rendererEngine: 'carla',
      baseImageDigest: null,
      baseImagePlatformDigest: null,
      engineCapabilitiesSha256: null,
      imageDigest: null,
      leasedAt: '2026-09-17T10:00:30.000Z',
      startedAt: '2026-09-17T10:00:31.000Z',
      completedAt: null,
    },
  ],
  events: [{ eventOrdinal: 1, eventKind: 'job.leased', attemptId: 'rat_1', detail: null, createdAt: JOB.createdAt }],
  artifacts: [ARTIFACT],
};

const GALLERY_ITEM = {
  id: JOB.id,
  revisionId: JOB.revisionId,
  documentId: 'uscn_e6e24608e08c48faa846f525',
  jobMode: 'full_render',
  rendererEngine: 'carla',
  jobState: 'succeeded',
  progressPercent: 100,
  failureCode: null,
  attemptCount: 1,
  createdAt: JOB.createdAt,
  completedAt: '2026-09-17T10:08:00.000Z',
  parentRenderJobId: null,
  modelFamily: null,
  revisionContentSha256: 'e'.repeat(64),
  revisionSourceDraftVersion: 7,
  artifactCount: 3,
  previewArtifactId: ARTIFACT.id,
  previewMediaType: ARTIFACT.mediaType,
};

let out: string[];
let err: string[];
let tmp: string;
const savedEnv = { base: process.env.SIMFORGE_API_BASE_URL, token: process.env.SIMFORGE_REMOTE_HOST_TOKEN };

beforeEach(async () => {
  out = [];
  err = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
  tmp = await mkdtemp(join(tmpdir(), 'simforge-render-cli-'));
  process.env.SIMFORGE_REMOTE_HOST_TOKEN = TOKEN;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tmp, { recursive: true, force: true });
  if (savedEnv.base === undefined) delete process.env.SIMFORGE_API_BASE_URL;
  else process.env.SIMFORGE_API_BASE_URL = savedEnv.base;
  if (savedEnv.token === undefined) delete process.env.SIMFORGE_REMOTE_HOST_TOKEN;
  else process.env.SIMFORGE_REMOTE_HOST_TOKEN = savedEnv.token;
});

function stdout<T>(): T {
  return JSON.parse(out.join('')) as T;
}

it('submit posts the submission the wire contract declares, and prints the job id', async () => {
  const host = await fakeHost({ 'POST /api/simforge/render-jobs': { status: 200, body: { ...JOB, status: 'queued' } } });
  process.env.SIMFORGE_API_BASE_URL = host.baseUrl;
  const specPath = join(tmp, 'render-spec.json');
  const spec = { schema: 'simforge.render-spec/v3', sources: [{ outputName: 'front', actorId: 'ego' }] };
  await writeFile(specPath, JSON.stringify(spec));
  try {
    await expect(
      run([
        'render', 'submit',
        '--revision', JOB.revisionId,
        '--execution-package', JOB.executionPackageId,
        '--engine', 'carla',
        '--render-spec', specPath,
        '--idempotency-key', 'gallery-yale-1',
        '--priority', '5',
      ]),
    ).resolves.toBe(0);
  } finally {
    host.close();
  }

  expect(host.received).toHaveLength(1);
  const call = host.received[0]!;
  expect(call.method).toBe('POST');
  expect(call.url).toBe('/api/simforge/render-jobs');
  expect(call.authorization).toBe(`Bearer ${TOKEN}`);
  expect(call.body).toEqual({
    schema: 'uniscenario.render-intent-submission/v1',
    engine: 'carla',
    revisionId: JOB.revisionId,
    executionPackageId: JOB.executionPackageId,
    renderSpec: spec,
    idempotencyKey: 'gallery-yale-1',
    priority: 5,
  });
  expect(stdout<{ jobId: string; status: string }>()).toMatchObject({ jobId: JOB.id, status: 'queued' });
});

it('submit derives an idempotency key from the revision, engine and rig when none is given', async () => {
  const host = await fakeHost({ 'POST /api/simforge/render-jobs': { status: 200, body: JOB } });
  process.env.SIMFORGE_API_BASE_URL = host.baseUrl;
  const specPath = join(tmp, 'render-spec.json');
  await writeFile(specPath, JSON.stringify({ schema: 'simforge.render-spec/v3', sources: [] }));
  try {
    await run(['render', 'submit', '--revision', JOB.revisionId, '--execution-package', JOB.executionPackageId, '--engine', 'carla', '--render-spec', specPath]);
  } finally {
    host.close();
  }
  const body = host.received[0]?.body as { idempotencyKey: string; priority?: number };
  expect(body.idempotencyKey).toMatch(new RegExp(`^render-intent:${JOB.revisionId}:carla:[0-9a-f]{16}$`));
  expect(body.priority).toBeUndefined();
});

it('status reads the job row and its detail row, reporting state, attempts and progress', async () => {
  const host = await fakeHost({
    [`GET /api/simforge/render-jobs/${JOB.id}`]: { status: 200, body: JOB },
    [`GET /api/simforge/render-jobs/${JOB.id}/detail`]: { status: 200, body: DETAIL },
  });
  process.env.SIMFORGE_API_BASE_URL = host.baseUrl;
  try {
    await expect(run(['render', 'status', JOB.id])).resolves.toBe(0);
  } finally {
    host.close();
  }
  expect(host.received.map((call) => `${call.method} ${call.url}`).sort()).toEqual([
    `GET /api/simforge/render-jobs/${JOB.id}`,
    `GET /api/simforge/render-jobs/${JOB.id}/detail`,
  ]);
  expect(stdout()).toMatchObject({
    jobId: JOB.id,
    state: 'running',
    progress: 0.42,
    progressPercent: 42,
    stage: 'rendering 420/1000 frames',
    engine: 'carla',
    attemptCount: 2,
    maxAttempts: 3,
    artifactCount: 1,
    attempts: [
      { attemptNumber: 1, state: 'failed', workerNodeId: 'vast-3090-01' },
      { attemptNumber: 2, state: 'running', workerNodeId: 'vast-3090-02' },
    ],
  });
});

it('download reads the one route that mints artifact URLs and prints them with their TTL', async () => {
  const host = await fakeHost({
    [`GET /api/simforge/render-jobs/${JOB.id}/downloads`]: {
      status: 200,
      body: {
        items: [
          { ...ARTIFACT, url: 'http://127.0.0.1:5199/api/local-objects/get/uart_video_1?sig=x', expiresInSeconds: 900 },
          { ...ARTIFACT, id: 'uart_trace_1', artifactKind: 'render_trace', identity: null, url: null },
        ],
        urlTtlSeconds: 900,
      },
    },
  });
  process.env.SIMFORGE_API_BASE_URL = host.baseUrl;
  try {
    await expect(run(['render', 'download', JOB.id])).resolves.toBe(0);
  } finally {
    host.close();
  }
  expect(host.received.map((call) => `${call.method} ${call.url}`)).toEqual([`GET /api/simforge/render-jobs/${JOB.id}/downloads`]);
  expect(stdout()).toEqual({
    jobId: JOB.id,
    artifacts: [
      {
        artifactId: ARTIFACT.id,
        role: 'video',
        modality: 'rgb',
        sensorId: 'camera_front_wide_120fov',
        actorId: 'ego',
        artifactKind: 'render_video',
        mediaType: 'video/mp4',
        byteLength: ARTIFACT.byteLength,
        sha256: ARTIFACT.sha256,
        state: 'available',
        url: 'http://127.0.0.1:5199/api/local-objects/get/uart_video_1?sig=x',
        expiresInSeconds: 900,
      },
      {
        artifactId: 'uart_trace_1',
        role: 'render_trace',
        modality: null,
        sensorId: null,
        actorId: null,
        artifactKind: 'render_trace',
        mediaType: 'video/mp4',
        byteLength: ARTIFACT.byteLength,
        sha256: ARTIFACT.sha256,
        state: 'available',
        url: null,
        expiresInSeconds: null,
      },
    ],
  });
});

it('list queries the gallery with its paging parameters and omits the filters it was not given', async () => {
  const host = await fakeHost({ 'GET /api/simforge/render-jobs/gallery': { status: 200, body: { items: [GALLERY_ITEM], hiddenCount: 4 } } });
  process.env.SIMFORGE_API_BASE_URL = host.baseUrl;
  try {
    await expect(run(['render', 'list', '--scenario', 'uscn_e6e24608e08c48faa846f525', '--limit', '25'])).resolves.toBe(0);
  } finally {
    host.close();
  }
  const query = new URL(host.received[0]!.url, 'http://host').searchParams;
  expect([...query.entries()].sort()).toEqual([
    ['documentId', 'uscn_e6e24608e08c48faa846f525'],
    ['limit', '25'],
  ]);
  expect(stdout()).toMatchObject({
    hiddenCount: 4,
    items: [{ id: JOB.id, state: 'succeeded', engine: 'carla', artifactCount: 3, documentId: 'uscn_e6e24608e08c48faa846f525' }],
  });
});

it("surfaces the host's own error body on a non-2xx answer", async () => {
  const host = await fakeHost({
    'POST /api/simforge/render-jobs': {
      status: 409,
      body: { error: 'idempotency_key_conflict', message: 'That idempotency key was used with a different render spec.' },
    },
  });
  process.env.SIMFORGE_API_BASE_URL = host.baseUrl;
  const specPath = join(tmp, 'render-spec.json');
  await writeFile(specPath, JSON.stringify({ schema: 'simforge.render-spec/v3', sources: [] }));
  try {
    await expect(
      run(['render', 'submit', '--revision', JOB.revisionId, '--execution-package', JOB.executionPackageId, '--engine', 'carla', '--render-spec', specPath]),
    ).resolves.toBe(1);
  } finally {
    host.close();
  }
  expect(JSON.parse(err.join(''))).toMatchObject({
    code: 'idempotency_key_conflict',
    reason: 'That idempotency key was used with a different render spec.',
    detail: { status: 409, operation: 'submitRenderIntent' },
  });
  expect(out.join('')).toBe('');
});

it('refuses a plaintext non-loopback host until the operator acknowledges it', async () => {
  process.env.SIMFORGE_API_BASE_URL = 'http://198.51.100.7:5421';
  await expect(run(['render', 'status', JOB.id])).resolves.toBe(1);
  expect(JSON.parse(err.join(''))).toMatchObject({ code: 'host_origin_plaintext_network', path: 'SIMFORGE_API_BASE_URL' });
});

it('names the verbs it has when asked for one it does not', async () => {
  process.env.SIMFORGE_API_BASE_URL = 'https://dev.simforge.ai';
  await expect(run(['render', 'artifacts', JOB.id])).resolves.toBe(1);
  const structured = JSON.parse(err.join('')) as { code: string; detail: { known: string[] } };
  expect(structured.code).toBe('unknown_command');
  expect(structured.detail.known).toContain('download');
  expect(structured.detail.known).not.toContain('artifacts');
});
