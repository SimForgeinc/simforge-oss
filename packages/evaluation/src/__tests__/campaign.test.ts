import { canonicalJson, sha256 } from '@simforge-oss/engine';
import { describe, expect, it } from 'vitest';

import { compareRerunTraces, deterministicTraceSha256 } from '../campaign.js';
import { EPISODE_TRACE_SCHEMA } from '../scoring.js';

function cameraTrace(pixelHash: string, sceneHash = 'same-world'): { native: string; legacy: string } {
  const cameras = { sceneStateDigest: sceneHash, frames: [{
    sensorId: 'front', pass: 'rgb', width: 2, height: 2, tick: 0,
    format: 'rgba8', rowStride: 256, digest: pixelHash, sha256: pixelHash,
  }] };
  const rows: Record<string, unknown>[] = [{ reset: {
    schema: EPISODE_TRACE_SCHEMA, seed: 1, t: 0,
    observation: { stateVector: [0, 0, 1, 0, 8, 0, 0, 0, 0, 100], cameras },
  } }, {
    step: 0, phase: 'policy', t: 0.1, sv: [0.8, 0, 1, 0, 8, 0, 0, 0, 0.8, 100],
    a: { k: 'c', c: [0, 0, 0] }, rw: 0.1, term: 0, trunc: 1, cameras,
    dl: { lim: null, el: null, miss: 0, ap: 'policy' },
  }];
  let digest = '';
  for (const row of rows) {
    digest = sha256(digest + canonicalJson(row));
    row['digest'] = digest;
  }
  rows.push({ episode_digest: digest, summary: {
    episodeDigest: digest, decisions: 1, status: 'succeeded',
    timing: { wallMs: 100, simulationS: 0.1, policySimulationS: 0.1 },
  } });
  const legacy = [
    { reset: { seed: 1, t: 0, sv: [0, 0, 1, 0, 8, 0, 0, 0, 0, 100], objs: [] } },
    { step: 0, t: 0.1, sv: [0.8, 0, 1, 0, 8, 0, 0, 0, 0.8, 100], objs: [] },
    { summary: { episode_digest: 'same-policy-chain', source_episode_digest: digest,
      source_schema: EPISODE_TRACE_SCHEMA, steps: 1, status: 'truncated' } },
  ].map((row) => JSON.stringify(row)).join('\n');
  return { native: rows.map((row) => JSON.stringify(row)).join('\n'), legacy };
}

describe('campaign rerun identity', () => {
  it('hashes nested summary values instead of silently whitelisting them away', () => {
    const first = JSON.stringify({ summary: { status: 'succeeded', model: { revision: 'a', family: 'policy' } } });
    const reordered = JSON.stringify({ summary: { model: { family: 'policy', revision: 'a' }, status: 'succeeded' } });
    const mutated = JSON.stringify({ summary: { status: 'succeeded', model: { revision: 'b', family: 'policy' } } });
    expect(deterministicTraceSha256(first)).toBe(deterministicTraceSha256(reordered));
    expect(deterministicTraceSha256(first)).not.toBe(deterministicTraceSha256(mutated));
  });

  it('excludes measured latency while retaining declared deadlines and simulation duration', () => {
    const trace = (latency: number, deadline = 100, simulationS = 1) => [
      { reset: { deadline_ms: deadline } },
      { step: 0, timing: { infer_ms: latency }, dl: { lim: deadline, el: latency, miss: 0 } },
      { summary: { steps: 1, infer_ms: { max: latency }, step_ms: { p50: latency },
        timing: { wallMs: latency, simulationS }, model: { revision: 'a', inferenceMs: { p50: latency } } } },
    ].map((row) => JSON.stringify(row)).join('\n');
    expect(deterministicTraceSha256(trace(1))).toBe(deterministicTraceSha256(trace(99)));
    expect(deterministicTraceSha256(trace(1))).not.toBe(deterministicTraceSha256(trace(1, 101)));
    expect(deterministicTraceSha256(trace(1))).not.toBe(deterministicTraceSha256(trace(1, 100, 2)));
  });

  it('reports only pixel-hash differences as renderer nondeterminism without failing identical policy/state', () => {
    const first = cameraTrace('first-pixels');
    const second = cameraTrace('second-pixels');
    const verdict = compareRerunTraces(first.legacy, second.legacy, first.native, second.native);
    expect(verdict.match).toBe(true);
    expect(verdict.rendererNondeterminism?.reason).toBe('renderer nondeterminism');
    expect(verdict.original.traceSha256Deterministic).not.toBe(verdict.rerun.traceSha256Deterministic);
    expect(verdict.rendererNondeterminism?.originalSourceEpisodeDigest).not.toBe(verdict.rendererNondeterminism?.rerunSourceEpisodeDigest);
  });

  it('does not excuse a changed native scene or missing native proof as pixel nondeterminism', () => {
    const first = cameraTrace('first-pixels');
    const changedScene = cameraTrace('second-pixels', 'changed-world');
    const changed = compareRerunTraces(first.legacy, changedScene.legacy, first.native, changedScene.native);
    expect(changed.match).toBe(false);
    expect(changed.rendererNondeterminism).toBeUndefined();
    const unproven = compareRerunTraces(first.legacy, cameraTrace('second-pixels').legacy);
    expect(unproven.match).toBe(false);
    expect(unproven.rendererNondeterminism).toBeUndefined();
    expect(compareRerunTraces(first.legacy, first.legacy).match).toBe(false);
  });
});
