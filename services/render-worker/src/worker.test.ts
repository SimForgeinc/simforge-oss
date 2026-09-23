import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { carlaProcessFailure, carlaRenderFailure, type JobLeasedResponse } from '@simforge-oss/render';
import { nativeMapMemberInputId } from '@simforge-oss/render/native';

import { boundedFailureMessage, boundedProgressRecord, createProgressForwarder, failureOf, heartbeatFailureIsFatal, validateClaimedInputs } from './worker.js';

type Input = JobLeasedResponse['inputs'][number];

const XOSC = { sha256: 'a'.repeat(64), sizeBytes: 42 };

function member(relativePath: string, sizeBytes: number, overrides: Partial<Input> = {}): Input {
  return {
    inputId: nativeMapMemberInputId(relativePath),
    relativePath,
    sha256: relativePath.length.toString(16).padStart(2, '0').repeat(32),
    sizeBytes,
    download: { url: `https://example.test/${relativePath}`, headers: {} },
    ...overrides,
  };
}

const xosc: Input = { inputId: 'scenario.xosc', ...XOSC, download: { url: 'https://example.test/xosc', headers: {} } };
const master = member('master.gltf', 1000);
const geometry = member('geometry.bin', 900);
const texture = member('images/road.ktx2', 148);

/** Intent declares `declared` per member; the lease serves `inputs` (defaults to the declaration). */
function lease(declared: Input[], inputs: Input[] = declared): Pick<JobLeasedResponse, 'intent' | 'inputs'> {
  return {
    intent: {
      scenarioRevision: { openScenario: XOSC },
      assets: declared.map(({ inputId, sha256, sizeBytes }) => ({ assetId: inputId, kind: 'map', sha256, sizeBytes })),
    } as JobLeasedResponse['intent'],
    inputs: [xosc, ...inputs],
  };
}

describe('native map closure admission', () => {
  it('rejects a lease missing a declared member', () => {
    expect(() => validateClaimedInputs(lease([master, geometry, texture], [master, texture]))).toThrow(
      `invalid missing claimed input ${geometry.inputId}`,
    );
  });

  it('rejects a served member whose digest drifted from its declaration', () => {
    const drifted = member('geometry.bin', 900, { sha256: 'f'.repeat(64) });
    expect(() => validateClaimedInputs(lease([master, geometry, texture], [master, drifted, texture]))).toThrow(
      `invalid claimed input metadata for ${geometry.inputId}`,
    );
  });

  it('rejects members the intent never declared, including undeclared tile ids', () => {
    const stray = member('geometry.bin', 900, { inputId: 'map.tile.000001' });
    expect(() => validateClaimedInputs(lease([master, texture], [master, stray, texture]))).toThrow(
      'invalid unreferenced claimed input map.tile.000001',
    );
  });

  it('rejects duplicate claimed members', () => {
    expect(() => validateClaimedInputs(lease([master, geometry], [master, geometry, geometry]))).toThrow(
      `invalid duplicate claimed input ${geometry.inputId}`,
    );
  });

  it('rejects a declared closure without master.gltf', () => {
    expect(() => validateClaimedInputs(lease([geometry, texture]))).toThrow(
      'invalid missing native map member map.tile.000000',
    );
  });

  it('rejects a member whose declared id was not derived from its served path', () => {
    const relocated = member('geometry.bin', 900, { relativePath: 'other.bin' });
    expect(() => validateClaimedInputs(lease([master, relocated, texture]))).toThrow(
      /does not derive from its path other\.bin/,
    );
  });

  it('rejects a member escaping the map root', () => {
    expect(() => validateClaimedInputs(lease([master, member('../geometry.bin', 900)]))).toThrow(
      'invalid unsafe native map member path: ../geometry.bin',
    );
  });

  it('rejects a member served without a path to reconstruct', () => {
    expect(() => validateClaimedInputs(lease([master, geometry], [master, { ...geometry, relativePath: undefined }]))).toThrow(
      `invalid native map member ${geometry.inputId} without relativePath`,
    );
  });
});

describe('best-effort control-plane reporting', () => {
  const record = (completed: number) => ({
    schema: 'simforge.render-progress/v1', event: 'stage.progress', stage: 'downloading', unit: 'items',
    jobId: 'usrj_x', attempt: 1, sequence: 0, timestamp: new Date().toISOString(), completed, total: 10,
  }) as never;

  it('drops failed progress records instead of failing, and coalesces queued snapshots', async () => {
    const sent: number[] = [];
    const logged: unknown[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const forwarder = createProgressForwarder(async (candidate) => {
      const completed = (candidate as { completed: number }).completed;
      if (completed === 1) {
        await gate;
        throw new Error('SimCloud control /events returned 409: {"error":"lease_invalid_or_expired"}');
      }
      sent.push(completed);
    }, () => false, (event) => logged.push(event));
    await forwarder.forward(record(1));
    for (let completed = 2; completed <= 9; completed += 1) await forwarder.forward(record(completed));
    release();
    await forwarder.flush();
    // Record 1 failed and was dropped; 2..8 were superseded by 9 while 1 was in flight.
    expect(sent).toEqual([9]);
    expect(logged).toHaveLength(1);
  });

  it('keeps a lease through heartbeat failures until its acknowledged expiry nears', () => {
    const now = 1_000_000;
    expect(heartbeatFailureIsFatal(new Error('fetch failed'), now + 600_000, 30_000, now)).toBe(false);
    expect(heartbeatFailureIsFatal(new Error('fetch failed'), now + 20_000, 30_000, now)).toBe(true);
    expect(heartbeatFailureIsFatal(new Error('control returned 409: lease_invalid_or_expired'), now + 600_000, 30_000, now)).toBe(true);
  });
});

describe('failure reporting', () => {
  it('bounds failure messages under the control plane cap and strips colour codes', () => {
    const long = `native render service did not become ready\n${'\u001b[33m WARN\u001b[0m wgpu validation '.repeat(400)}tail-marker`;
    const bounded = boundedFailureMessage(long);
    expect(bounded.length).toBeLessThanOrEqual(2000);
    expect(bounded).toContain('native render service did not become ready');
    expect(bounded).toContain('tail-marker');
    expect(bounded).not.toContain('\u001b[');
  });

  // The control plane refuses a failure whose message is empty after trim or
  // over 2,000 characters, or whose code is over 100: the report fails and the
  // lease is orphaned until it expires. Nothing the worker sends may exceed that.
  it('never reports a failure the control plane would refuse', () => {
    for (const error of [new Error(''), new Error('   \n  '), new Error('\u001b[31m\u001b[0m'), '']) {
      const failure = failureOf(error);
      expect(failure.message.trim().length).toBeGreaterThan(0);
    }
    expect(failureOf(new Error('x'.repeat(50_000))).message.length).toBeLessThanOrEqual(2000);
    const coded = Object.assign(new Error('out of memory'), { code: `native_${'a'.repeat(120)}`, retryable: false });
    const failure = failureOf(coded);
    expect(failure.code.length).toBeLessThanOrEqual(100);
    expect(failure.code).toMatch(/^render\.native_a+$/);
  });

  it('reports a crashed CARLA process with its scrubbed stderr tail and exit, retryable', () => {
    const crash = carlaProcessFailure({ code: 1, signal: null }, [
      'Traceback (most recent call last):',
      'GET https://blobs.example/in.xosc?X-Amz-Signature=0123456789abcdef',
      'RuntimeError: CARLA synchronous tick barrier is broken',
    ].join('\n'));
    const failure = failureOf(crash);
    expect(failure.code).toBe('render.carla_process_failed');
    expect(failure.retryable).toBe(true);
    expect(failure.message).toContain('RuntimeError: CARLA synchronous tick barrier is broken');
    expect(failure.message).not.toContain('0123456789abcdef');
    expect(failure.details).toEqual({ exitCode: 1, signal: null, stderrTail: expect.stringContaining('tick barrier') });
    expect(JSON.stringify(failure)).not.toContain('0123456789abcdef');
  });

  it('never retries a deterministic CARLA refusal', () => {
    const refusal = carlaRenderFailure(JSON.stringify({
      schema: 'simforge.carla-render-failure/v1', code: 'carla_render_contract_violation',
      message: '[carla_render_contract_violation] renderSpec.clip ends after the authored clip', retryable: false,
    }));
    const failure = failureOf(refusal);
    expect(failure).toEqual({
      code: 'render.carla_render_contract_violation',
      message: 'renderSpec.clip ends after the authored clip',
      retryable: false,
    });
    expect(failureOf(carlaProcessFailure({ code: 3, signal: null }, 'garbled')).retryable).toBe(false);
  });

  it('caps warning messages and cancellation reasons at the control plane limit', () => {
    const base = { schema: 'simforge.render-progress/v1' as const, jobId: 'usrj_1', attempt: 1, sequence: 1, timestamp: new Date().toISOString() };
    const warning = boundedProgressRecord({ ...base, event: 'warning', code: 'native_parity', message: 'w'.repeat(4096) });
    expect(warning.event === 'warning' && warning.message.length).toBeLessThanOrEqual(2000);
    const canceled = boundedProgressRecord({ ...base, event: 'job.canceled', reason: 'r'.repeat(4096) });
    expect(canceled.event === 'job.canceled' && canceled.reason.length).toBeLessThanOrEqual(2000);
  });
});
