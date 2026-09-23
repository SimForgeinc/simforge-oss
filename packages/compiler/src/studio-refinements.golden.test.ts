/**
 * Golden cross-check: the native Studio refinements
 * (`simforge_compiler::studio_refinements`) against the frozen TypeScript
 * implementations they replace. Every case must resolve to the same native
 * input (content hash of the engine-normalised document) and, where it runs,
 * the same trace digest.
 */

import { describe, expect, it } from 'vitest';

import { contentHash, type SimScenarioInput } from '@simforge-oss/engine';
import { engine } from '@simforge-oss/engine/node';

import {
  LANE_LEFT,
  scenario,
  syntheticGraph,
  vehicle,
} from '../../engine/src/__tests__/fixtures/scenarios';
import {
  bakedParkedCarsFromExtensions,
  withBoundedSpeedCruiseRestoration,
  withParkedCarActors,
  withStableHighSpeedWorldRoutes,
  withStudioBodyColorTags,
} from './__fixtures__/legacy-studio-refinements';
import { readCorpus, closureDir, loadCaseBundle, resolvedInputPath } from '../../cli/src/determinism/golden-traces';

const graph = syntheticGraph();

function normalized(input: unknown): string {
  return contentHash(JSON.parse(engine().scenario(input as SimScenarioInput).toJson()));
}

function nativeJson(handle: { toJson(): string }): SimScenarioInput {
  return JSON.parse(handle.toJson()) as SimScenarioInput;
}

type Template = { roles: Array<{ id: string; extensions?: Record<string, unknown> }>; extensions?: Record<string, unknown> };

function legacyConcrete(input: SimScenarioInput, template: Template): SimScenarioInput {
  return withParkedCarActors(withStudioBodyColorTags(input, template), bakedParkedCarsFromExtensions(template.extensions));
}

function legacyExecution(input: SimScenarioInput): SimScenarioInput {
  return withBoundedSpeedCruiseRestoration(withStableHighSpeedWorldRoutes(input));
}

function base(): SimScenarioInput {
  const input = scenario({
    seed: 'studio-refinements',
    clipSeconds: 12,
    actors: [
      { ...vehicle(graph, { id: 'ego', rsl: LANE_LEFT, s: 40, speedMps: 24, cruiseSpeedMps: 24 }), tags: ['role:ego', 'studio:body-color:#000000'] },
      { ...vehicle(graph, { id: 'lead', rsl: LANE_LEFT, s: 90, speedMps: 8, cruiseSpeedMps: 11 }), tags: ['role:lead'] },
      { ...vehicle(graph, { id: 'slow', rsl: LANE_LEFT, s: 150, speedMps: 5 }), tags: ['role:slow'] },
    ],
  });
  return input;
}

const route = (actorId: string, id: string, extra: Record<string, unknown>) => ({
  id, actorId, trigger: { kind: 'at', t: 1 }, verb: 'route',
  target: { kind: 'polyline', points: [{ x: 10, z: 0 }, { x: 60, z: 4 }, { x: 120, z: 30 }] },
  ...extra,
});
const speed = (actorId: string, id: string, window: { startS: number; endS: number } | null, t = 1) => ({
  id, actorId, trigger: { kind: 'at', t }, verb: 'speed',
  target: { mode: 'absolute', value: 4 },
  dynamics: { shape: 'linear', constraint: 'rate', value: 2 },
  ...(window ? { window } : {}),
});

function executionCases(): Record<string, SimScenarioInput> {
  const input = base();
  const withInteractions = (interactions: unknown[], patch: Partial<SimScenarioInput> = {}) =>
    ({ ...input, ...patch, interactions: [...input.interactions, ...interactions] }) as SimScenarioInput;
  return {
    untouched: input,
    worldRouteJoin: withInteractions([route('ego', 'r1', { bestEffortWorldPath: true, joinFromCurrentPose: true })]),
    worldRouteSlowActor: withInteractions([route('slow', 'r2', { bestEffortWorldPath: true, joinFromCurrentPose: true })]),
    worldRouteNotBestEffort: withInteractions([route('ego', 'r3', { joinFromCurrentPose: true })]),
    // A tighter authored cap than grip allows is kept as is.
    worldRouteAuthoredProfile: withInteractions(
      [route('ego', 'r4', { bestEffortWorldPath: true })],
      { physics: { mode: 'dynamic-v1', vehicleProfiles: { ego: { maxYawRateRadps: 0.1, maxLateralAccelerationMps2: 4 } } } } as never,
    ),
    worldRouteLooseProfile: withInteractions(
      [route('ego', 'r5', { bestEffortWorldPath: true })],
      { physics: { mode: 'kinematic-v1', vehicleProfiles: { ego: { maxYawRateRadps: 2 } } } } as never,
    ),
    boundedSpeed: withInteractions([speed('lead', 's1', { startS: 1, endS: 5 })]),
    boundedSpeedAtClipEnd: withInteractions([speed('lead', 's2', { startS: 1, endS: 12 })]),
    boundedSpeedNoCruise: withInteractions([speed('slow', 's3', { startS: 1, endS: 5 })]),
    boundedSpeedTakenOver: withInteractions([speed('lead', 's4', { startS: 1, endS: 5 }), speed('lead', 's5', null, 5)]),
    boundedSpeedIdCollision: withInteractions([
      speed('lead', 's6', { startS: 1, endS: 5 }),
      { ...speed('lead', 'restore-cruise-s6', null, 9) },
    ]),
    everything: withInteractions([
      route('ego', 'r6', { bestEffortWorldPath: true, joinFromCurrentPose: true }),
      speed('ego', 's7', { startS: 2, endS: 6 }),
      speed('lead', 's8', { startS: 1, endS: 4 }),
    ]),
  };
}

function concreteCases(): Record<string, { input: SimScenarioInput; template: Template }> {
  const input = base();
  const roles = (colors: Record<string, unknown>) => ['ego', 'lead', 'slow'].map((id) => ({
    id, ...(id in colors ? { extensions: { 'studio.presentation.bodyColor': colors[id] } } : {}),
  }));
  const car = (id: string, x: number, z: number, h: number) => ({
    id, stallId: `st-${id}`, catalogId: 'vehicle.sedan', x, y: 0, z, headingRad: h, lengthM: 4.6, widthM: 1.85, heightM: 1.5,
  });
  const cases: Record<string, { input: SimScenarioInput; template: Template }> = {
    noStudioContent: { input, template: { roles: roles({}) } },
    paintSpellings: { input, template: { roles: roles({ ego: '#AbC', lead: 'rgb(12, 200, 7)', slow: ' 255,0,16 ' }) } },
    paintExoticChannels: { input, template: { roles: roles({ ego: 'rgb(,5.0,0x1f)', lead: 'rgb(+2,1e2,0)', slow: 'rgb(1.,.0,0)' }) } },
    paintInvalid: { input, template: { roles: roles({ ego: 'rgb(256,0,0)', lead: '#abcd', slow: 7 }) } },
    parkedCars: {
      input,
      template: {
        roles: roles({}),
        extensions: {
          'studio.ambientTraffic.parkedCars.v1': {
            baked: [car('parked:z', 30, 12, 0.4), car('parked:a', 55, -12, 3.1), car('lead', 1, 1, 0), { id: 'parked:x', catalogId: 'vehicle.sedan' }, car('parked:B', 80, 12, 1.0)],
          },
        },
      },
    },
    parkedMalformedBag: { input, template: { roles: roles({}), extensions: { 'studio.ambientTraffic.parkedCars.v1': { baked: 'no' } } } },
  };
  cases['paintedAndParked'] = { input, template: { ...cases['parkedCars']!.template, roles: roles({ ego: '#123456' }) } };
  return cases;
}

/** Cases that must change the input: every branch is exercised, not just the identity. */
const EXECUTION_CHANGES = new Set(['worldRouteJoin', 'worldRouteLooseProfile', 'boundedSpeed', 'everything']);
// Every concrete case drops the base input's stale paint tag on `ego`.
const CONCRETE_CHANGES = new Set(['noStudioContent', 'paintSpellings', 'paintExoticChannels', 'paintInvalid', 'parkedCars', 'parkedMalformedBag', 'paintedAndParked']);

describe('native Studio refinements match the frozen TypeScript', () => {
  it('execution refinements resolve to the same input and trace', () => {
    for (const [name, input] of Object.entries(executionCases())) {
      const legacy = legacyExecution(input);
      const native = nativeJson(engine().executionRefinements(input));
      expect(normalized(native), name).toBe(normalized(legacy));
      expect(normalized(native) !== normalized(input), `${name} changes`).toBe(EXECUTION_CHANGES.has(name));
      const legacyTrace = engine().runSimulation(legacy, { graph }).trace;
      const nativeTrace = engine().runSimulation(native, { graph }).trace;
      expect(engine().traceDigest(nativeTrace), name).toBe(engine().traceDigest(legacyTrace));
    }
  });

  it('studio concrete input resolves to the same input and trace', () => {
    for (const [name, { input, template }] of Object.entries(concreteCases())) {
      const legacy = legacyConcrete(input, template);
      const native = nativeJson(engine().studioConcreteInput(input, template));
      expect(normalized(native), name).toBe(normalized(legacy));
      expect(normalized(native) !== normalized(input), `${name} changes`).toBe(CONCRETE_CHANGES.has(name));
      const legacyTrace = engine().runSimulation(legacy, { graph }).trace;
      const nativeTrace = engine().runSimulation(native, { graph }).trace;
      expect(engine().traceDigest(nativeTrace), name).toBe(engine().traceDigest(legacyTrace));
    }
  });

  it('is idempotent and leaves an untouched input unchanged', () => {
    const input = executionCases()['everything']!;
    const once = nativeJson(engine().executionRefinements(input));
    expect(normalized(nativeJson(engine().executionRefinements(once)))).toBe(normalized(once));
    const untouched = executionCases()['untouched']!;
    expect(normalized(nativeJson(engine().executionRefinements(untouched)))).toBe(normalized(untouched));
  });

  it('agrees on every installed golden-corpus input', async () => {
    let compared = 0;
    for (const testCase of readCorpus().cases) {
      if (!closureDir(testCase)) continue;
      if (testCase.source.kind !== 'input' && testCase.tier !== 'ci') continue;
      const bundle = await loadCaseBundle(testCase);
      void bundle;
      const { readFileSync } = await import('node:fs');
      const { gunzipSync } = await import('node:zlib');
      const bytes = readFileSync(resolvedInputPath(testCase));
      const document = JSON.parse((bytes[0] === 0x1f ? gunzipSync(bytes) : bytes).toString('utf8')) as Record<string, unknown>;
      const input = ('input' in document && 'manifest' in document ? document['input'] : document) as SimScenarioInput;
      expect(normalized(nativeJson(engine().executionRefinements(input))), testCase.id).toBe(normalized(legacyExecution(input)));
      compared += 1;
    }
    expect(compared).toBeGreaterThan(0);
  }, 240_000);
});
