import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { RenderIntentV1 } from '@simforge-oss/scenario';

import { CarlaProcessError, carlaProcessFailure, loadBuiltinRenderEngine } from './builtin-engines.js';
import { scrubbedLogTail, scrubSecrets } from './log-scrub.js';
import { RenderInputError } from './render-input-error.js';

const SECRETS = [
  'https://bucket.s3.amazonaws.com/renders/usrj_1/scene.xosc?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20260923&X-Amz-Signature=deadbeefcafef00d',
  'Authorization: Bearer sk-live-0123456789abcdefghijklmnop',
  'postgres://simforge:hunter2-db-password@db.internal:5432/simforge',
  'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  '"fenceToken": "a7f3c9e1b2d4f6a8c0e2b4d6f8a0c2e4"',
  'aws key AKIAIOSFODNN7EXAMPLE in a log line',
  'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.c2lnbmF0dXJlc2lnbmF0dXJl',
];
const LEAKED = [
  'deadbeefcafef00d', 'AKIAIOSFODNN7EXAMPLE', 'sk-live-0123456789', 'hunter2-db-password',
  'wJalrXUtnFEMI', 'a7f3c9e1b2d4f6a8c0e2b4d6f8a0c2e4', 'c2lnbmF0dXJlc2lnbmF0dXJl',
];

describe('process log scrubbing', () => {
  it('redacts credentials while keeping the explanation readable', () => {
    const scrubbed = scrubSecrets(SECRETS.join('\n'));
    for (const secret of LEAKED) expect(scrubbed).not.toContain(secret);
    expect(scrubbed).toContain('https://bucket.s3.amazonaws.com/renders/usrj_1/scene.xosc?[redacted]');
    expect(scrubbed).toContain('db.internal:5432/simforge');
    expect(scrubSecrets("{'authoredEnvironment': 'clear'}")).toBe("{'authoredEnvironment': 'clear'}");
    expect(scrubSecrets('ContractError: CARLA run-intent currently requires the full authored clip'))
      .toBe('ContractError: CARLA run-intent currently requires the full authored clip');
  });

  it('keeps only the last lines, bounded, without colour codes or a partial first line', () => {
    const lines = Array.from({ length: 100 }, (_, index) => `\u001b[31mline ${index}\u001b[0m`);
    const tail = scrubbedLogTail(lines.join('\n'), { maxLines: 5 });
    expect(tail.split('\n')).toEqual(['line 95', 'line 96', 'line 97', 'line 98', 'line 99']);
    expect(scrubbedLogTail(`X-Amz-Signature=secretpart\nTraceback\nboom`, { truncatedHead: true })).toBe('Traceback\nboom');
    const bounded = scrubbedLogTail(`${'x'.repeat(5000)}\nlast`, { maxChars: 100 });
    expect(bounded.length).toBeLessThanOrEqual(101);
    expect(bounded.endsWith('last')).toBe(true);
  });
});

describe('CARLA process failures', () => {
  const traceback = [
    'Traceback (most recent call last):',
    '  File "/usr/local/bin/simforge-oss-carla-exec", line 8, in <module>',
    `    fetch ${SECRETS[0]}`,
    'RuntimeError: CARLA synchronous tick barrier is broken',
  ].join('\n');

  it('an unexplained crash carries the scrubbed stderr tail and stays retryable', () => {
    const error = carlaProcessFailure({ code: 1, signal: null }, traceback);
    expect(error).toBeInstanceOf(CarlaProcessError);
    expect(error.code).toBe('carla_process_failed');
    expect(error.retryable).toBe(true);
    expect(error.message).toContain('exited with code 1');
    expect(error.message).toContain('RuntimeError: CARLA synchronous tick barrier is broken');
    expect(error.message).not.toContain('deadbeefcafef00d');
    expect(error.details).toEqual({ exitCode: 1, signal: null, stderrTail: expect.stringContaining('tick barrier') });
  });

  it('exit 3 without a readable record is still a non-retryable refusal', () => {
    const error = carlaProcessFailure({ code: 3, signal: null }, 'garbled');
    expect(error.code).toBe('carla_process_refused');
    expect(error.retryable).toBe(false);
  });

  it('names a kill and says when stderr was empty', () => {
    const error = carlaProcessFailure({ code: null, signal: 'SIGKILL' }, '');
    expect(error.message).toBe('CARLA renderer was killed by SIGKILL without a failure record; stderr was empty');
  });
});

const INTENT = {
  schema: 'simforge.render-intent/v1',
  intentId: 'intent-1',
  executionPackage: { id: 'package-1', sourceInputDigest: 'a'.repeat(64) },
  scenarioRevision: {
    revisionId: 'revision-1',
    scenarioSha256: 'b'.repeat(64),
    openScenario: { sha256: 'c'.repeat(64), sizeBytes: 1 },
    map: { mapId: 'map-1', revisionId: 'map-revision-1', sha256: 'd'.repeat(64) },
  },
  sensorHosts: [{ sourceId: 'ego-camera-front-rgb', actorId: 'ego', vehicleAsset: { catalogAssetId: 'vehicle.kia.carnival' } }],
  renderSpec: {
    schema: 'simforge.render-spec/v3',
    sources: [{
      actorId: 'ego', sensorId: 'camera-front', outputName: 'ego-camera-front-rgb',
      transform: { position: { x: 1, y: 2, z: 0 }, rotation: { yawRad: 0, pitchRad: 0, rollRad: 0 } },
      modality: 'rgb',
      attributes: { width: 1280, height: 720, fps: 24, horizontalFovDeg: 90, nearM: 0.05, farM: 1000 },
    }],
    clip: { startSeconds: 0, endSeconds: 10 },
    video: { width: 1280, height: 720, fps: 24, container: 'mp4', codec: 'h264', quality: 'standard' },
    artifacts: ['manifest', 'video'],
    capabilityIntent: { required: ['sensor.rgb', 'artifact.manifest', 'artifact.video'], preferred: [], fidelity: 'dataset' },
    authoredEnvironment: { weather: 'clear', timeOfDay: 'noon', surfacePatches: [] },
  },
  assets: [{ assetId: 'map.xodr', kind: 'map', sha256: 'e'.repeat(64), sizeBytes: 1 }],
  seed: 1,
} as unknown as RenderIntentV1;

async function runFakeAdapter(script: string): Promise<unknown> {
  const directory = await mkdtemp(join(tmpdir(), 'carla-process-'));
  const binary = join(directory, 'fake-carla-exec');
  await writeFile(binary, `#!/bin/sh\n${script}\n`);
  await chmod(binary, 0o755);
  const engine = await loadBuiltinRenderEngine('carla', { binary, engineVersion: 'f'.repeat(40) });
  return engine.execute({
    jobId: 'usrj_1', attempt: 1, intent: INTENT, intentSha256: '1'.repeat(64),
    executionPackageControlSha256: '2'.repeat(64), schedules: [], inputs: new Map(),
    workspace: join(directory, 'workspace'), signal: new AbortController().signal,
    reportProgress: async () => undefined,
  }).then(() => undefined, (error: unknown) => error);
}

describe('the CARLA process engine', () => {
  it('reports a crash with its scrubbed stderr tail instead of a bare failure', async () => {
    const error = await runFakeAdapter([
      `echo 'Traceback (most recent call last):' >&2`,
      `echo 'token=supersecretvalue123 while leasing' >&2`,
      `echo 'simforge_oss_carla_exec.runtime.contract.ContractError: CARLA run-intent currently requires the full authored clip' >&2`,
      'exit 1',
    ].join('\n'));
    expect(error).toBeInstanceOf(CarlaProcessError);
    const failure = error as CarlaProcessError;
    expect(failure.retryable).toBe(true);
    expect(failure.message).toContain('ContractError: CARLA run-intent currently requires the full authored clip');
    expect(failure.message).not.toContain('supersecretvalue123');
  });

  it('turns the failure record of a deterministic refusal into a non-retryable coded error', async () => {
    const record = JSON.stringify({
      schema: 'simforge.carla-render-failure/v1', code: 'carla_render_contract_violation',
      message: '[carla_render_contract_violation] input package intentSha256 does not match', retryable: false,
    });
    const error = await runFakeAdapter(`echo '${record}'\nexit 3`);
    expect(error).toBeInstanceOf(RenderInputError);
    expect((error as RenderInputError).code).toBe('carla_render_contract_violation');
    expect((error as RenderInputError).retryable).toBe(false);
  });
});
