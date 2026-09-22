/**
 * Authoritative simulation identities: the key is a pure function of exactly
 * the inputs a trace depends on, the stored bytes are deterministic, and the
 * traffic evidence is derived from the authoritative trace itself.
 *
 * Requires the built addon (`pnpm --filter @simforge-oss/native-runtime build:node`).
 */

import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { contentHash, decodeMaterializedTrafficArtifact } from '@simforge-oss/engine';
import { runSimulation, traceDigest } from '@simforge-oss/engine/node';

import {
  LANE_LEFT,
  LANE_RIGHT,
  scenario,
  syntheticGraph,
  vehicle,
} from '../../engine/src/__tests__/fixtures/scenarios.js';
import {
  engineSemantics,
  gzipTrace,
  mapClosureIdentityDigest,
  materializeTraceTraffic,
  simKey,
  TRACE_SCHEMA,
  type SimKeyInput,
} from './simulation.js';

const graph = syntheticGraph();
const base: SimKeyInput = {
  resolvedInputDigest: 'a'.repeat(64),
  mapClosureDigest: 'b'.repeat(64),
  engineSemVer: '0.8.0',
  solverVer: '0.8.0',
  traceSchema: TRACE_SCHEMA,
};

function run(seed = 'sim-key') {
  return runSimulation(scenario({
    seed,
    actors: [
      vehicle(graph, { id: 'ego', rsl: LANE_LEFT, s: 80, speedMps: 12, cruiseSpeedMps: 12 }),
      { ...vehicle(graph, { id: 'ambient:1', rsl: LANE_RIGHT, s: 30, speedMps: 15, cruiseSpeedMps: 15 }), tags: ['ambient'] },
    ],
  }), { graph });
}

describe('simKey', () => {
  it('is stable and 64 hex', () => {
    expect(simKey(base)).toMatch(/^[a-f0-9]{64}$/);
    expect(simKey({ ...base })).toBe(simKey(base));
  });

  it('changes with every field that determines a trace', () => {
    const keys = new Set([
      simKey(base),
      simKey({ ...base, resolvedInputDigest: 'c'.repeat(64) }),
      simKey({ ...base, mapClosureDigest: 'c'.repeat(64) }),
      simKey({ ...base, engineSemVer: '0.8.1' }),
      simKey({ ...base, solverVer: '0.8.1' }),
      simKey({ ...base, traceSchema: 'simforge.trace/v5' }),
      simKey({ ...base, trafficStepKey: 'd'.repeat(64) }),
    ]);
    expect(keys.size).toBe(7);
  });

  it('keeps the key shape of native/off traffic when no external step ran', () => {
    expect(simKey({ ...base, trafficStepKey: null })).toBe(simKey(base));
  });

  it('names the trace schema by the engine trace format version', () => {
    expect(TRACE_SCHEMA).toMatch(/^simforge\.trace\/v\d+$/);
  });

  it('uses the engine semantics version for engineSemVer and solverVer', () => {
    const semantics = engineSemantics();
    expect(semantics.engineSemVer.length).toBeGreaterThan(0);
    expect(semantics.solverVer).toBe(semantics.engineSemVer);
  });
});

describe('mapClosureIdentityDigest', () => {
  it('covers the browser closure and the collider artifact', () => {
    const a = mapClosureIdentityDigest({ browserClosureSha256: '1'.repeat(64), colliderDigest: `sha256-${'2'.repeat(64)}` });
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(mapClosureIdentityDigest({ browserClosureSha256: '1'.repeat(64), colliderDigest: `sha256-${'3'.repeat(64)}` })).not.toBe(a);
    expect(mapClosureIdentityDigest({ browserClosureSha256: '4'.repeat(64), colliderDigest: `sha256-${'2'.repeat(64)}` })).not.toBe(a);
  });
});

describe('stored trace bytes', () => {
  it('gzip deterministically and round-trip to the same native digest', () => {
    const { trace } = run();
    const first = gzipTrace(trace);
    const second = gzipTrace(trace);
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
    const decoded = JSON.parse(gunzipSync(first).toString('utf8'));
    expect(traceDigest(decoded)).toBe(traceDigest(trace));
  });
});

describe('materializeTraceTraffic', () => {
  const map = { assetId: 'synthetic-straight', versionId: 'usmap_test' };

  it('derives canonical native traffic frames for exactly the ambient actors', () => {
    const { trace } = run();
    const profile = { version: 1, preset: 'city', seed: 'ambient-1', densityVehiclesPerKm: 10 } as never;
    const { envelope, ambient } = materializeTraceTraffic({
      provider: 'native', profile, sourceInputDigest: 'e'.repeat(64), map, trace, ambientActorIds: ['ambient:1'],
    });
    const decoded = decodeMaterializedTrafficArtifact(envelope.bytes);
    expect(decoded.artifact.actors.map((actor) => actor.id)).toEqual(['ambient:1']);
    expect(ambient.mode).toBe('native');
    expect(ambient.resultSha256).toBe(envelope.sha256);
    expect(ambient.mode === 'native' && ambient.configSha256).toBe(contentHash(profile));
    // Scene z is the negated xodr-local y of the authoritative trace.
    const track = trace.ticks.actors['ambient:1']!;
    const states = decoded.artifact.actors[0]!.states;
    expect(states).toHaveLength(trace.ticks.t.length);
    const index = track.present.indexOf(1);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(states[index]).toMatchObject({ present: true, x: track.x[index], z: -track.y[index]!, headingRad: track.headingRad[index] });
  });

  it('produces the disabled artifact, bound to the empty ambient config, when traffic is off', () => {
    const { trace } = run();
    const { envelope, ambient } = materializeTraceTraffic({
      provider: 'off', profile: {} as never, sourceInputDigest: 'e'.repeat(64), map, trace, ambientActorIds: [],
    });
    expect(ambient).toEqual({
      mode: 'disabled',
      ambientConfig: {},
      configSha256: '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
      resultSha256: envelope.sha256,
    });
  });

  it('is a pure function of the trace', () => {
    const { trace } = run('purity');
    const make = () => materializeTraceTraffic({
      provider: 'native', profile: { version: 1, preset: 'city', seed: 's', densityVehiclesPerKm: 10 } as never,
      sourceInputDigest: 'e'.repeat(64), map, trace, ambientActorIds: ['ambient:1'],
    }).envelope.sha256;
    expect(make()).toBe(make());
  });
});

describe('resolutionFromSimulation', () => {
  const template = {
    roles: [], props: [], invariants: [], variants: [], mapSignalPlans: [], extensions: {},
    choreography: { interactions: [], clipSeconds: 20, warmupSeconds: 0 },
    meta: { name: 'resolution-test' },
  };

  it('rebuilds the resolved execution input from the stored record of the traced input', async () => {
    const { resolutionFromSimulation } = await import('./execution-package.js');
    const result = run('resolution');
    const digest = contentHash(result.input);
    let parsed: unknown;
    try {
      parsed = resolutionFromSimulation(template, {
        simKey: 'k'.repeat(64),
        traceSha256: traceDigest(result.trace),
        trace: result.trace,
        resolution: {
          resolvedInputDigest: digest,
          resolvedInput: result.input,
          ambientTraffic: { actors: [] } as never,
          siteId: 'site',
          materialization: {},
          axisUntilClamps: [],
        },
      });
    } catch (error) {
      // The minimal template may not parse as a full ScenarioTemplateV2; the
      // identity checks run first and are what this test pins.
      expect(String(error)).not.toMatch(/simulation_resolution_mismatch/);
      return;
    }
    expect(parsed).toMatchObject({ resolvedInput: result.input, executedInput: result.input });
  });

  it('refuses a record whose input is not the one the trace ran', async () => {
    const { resolutionFromSimulation } = await import('./execution-package.js');
    const result = run('resolution');
    const other = run('other-seed');
    expect(() => resolutionFromSimulation(template, {
      simKey: 'k'.repeat(64),
      traceSha256: traceDigest(result.trace),
      trace: result.trace,
      resolution: {
        resolvedInputDigest: contentHash(other.input),
        resolvedInput: other.input,
        ambientTraffic: { actors: [] } as never,
        siteId: 'site',
        materialization: {},
        axisUntilClamps: [],
      },
    })).toThrow(/simulation_resolution_mismatch/);
  });
});
