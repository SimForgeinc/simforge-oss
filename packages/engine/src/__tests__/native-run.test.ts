/**
 * Consumer contract of `@simforge-oss/engine/node`: a whole-clip run executes in
 * the native runtime and comes back as the documented `SimResult`, with the
 * trace identity the rest of the toolchain relies on.
 *
 * Requires the built addon (`pnpm --filter @simforge-oss/native-runtime build:node`).
 */

import { describe, expect, it } from 'vitest';

import { contentHash } from '../core/hash.js';
import { evaluateTrace, parseTrace, runSimulation, runtimeIdentity, sceneState, traceDigest } from '../node.js';
import { sceneStateSchema } from '../scene-state/schema.js';
import { LANE_LEFT, LANE_RIGHT, scenario, syntheticGraph, vehicle } from './fixtures/scenarios.js';

const graph = syntheticGraph();

function pairScenario(seed: string) {
  return scenario({
    seed,
    metricSubject: 'ego',
    actors: [
      vehicle(graph, { id: 'ego', rsl: LANE_LEFT, s: 80, speedMps: 14, cruiseSpeedMps: 14 }),
      vehicle(graph, { id: 'lead', rsl: LANE_LEFT, s: 190, speedMps: 11, cruiseSpeedMps: 11 }),
      vehicle(graph, { id: 'neighbour', rsl: LANE_RIGHT, s: 20, speedMps: 18, cruiseSpeedMps: 18 }),
    ],
  });
}

describe('native whole-clip run', () => {
  it('returns the executed input, a trace whose inputHash is the canonical content hash, and evaluates it natively', () => {
    const result = runSimulation(pairScenario('native-run'), { graph });

    expect(result.trace.header.inputHash).toBe(contentHash(result.input));
    expect(result.trace.ticks.t.length).toBeGreaterThan(0);
    expect(Object.keys(result.trace.ticks.actors).sort()).toEqual(['ego', 'lead', 'neighbour']);
    expect(result.trace.ticks.actors['ego']!.lateralOffsetM).toHaveLength(result.trace.ticks.t.length);

    const evaluation = evaluateTrace(result.trace);
    expect(['accept', 'reject']).toContain(evaluation.verdict);
    expect(evaluation.summary.collisions).toBe(result.trace.metrics.collisions.length);
  });

  it('is repeatable across runs and distinguishes seeds by trace digest', () => {
    const a = runSimulation(pairScenario('repeat'), { graph });
    const b = runSimulation(pairScenario('repeat'), { graph });
    const c = runSimulation(pairScenario('other-seed'), { graph });

    expect(traceDigest(a.trace)).toBe(traceDigest(b.trace));
    expect(parseTrace(a.trace).canonicalJson()).toBe(parseTrace(b.trace).canonicalJson());
    expect(c.trace.header.inputHash).not.toBe(a.trace.header.inputHash);
  });

  it('emits a scene-state document that validates against the shared schema', () => {
    const { trace } = runSimulation(pairScenario('scene-state'), { graph });
    const state = sceneState(trace);
    expect(sceneStateSchema.parse(state).frames.length).toBe(trace.ticks.t.length);
  });

  it('reports the loaded addon identity', () => {
    const identity = runtimeIdentity();
    expect(identity.addonSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(identity.engineVersion.length).toBeGreaterThan(0);
  });
});
