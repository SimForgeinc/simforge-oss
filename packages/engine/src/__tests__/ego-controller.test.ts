import { describe, expect, it } from 'vitest';
import { runSimulation } from '../sim/engine.js';
import type { SimTrace } from '../trace/trace.js';
import { scenario, syntheticGraph, vehicle } from './fixtures/scenarios.js';

const graph = syntheticGraph();

function occludedLeaderScenario() {
  return scenario(graph, {
    clipSeconds: 3,
    warmupSeconds: 0,
    metricSubject: 'ego',
    actors: [
      vehicle(graph, { id: 'ego', s: 0, speedMps: 10, cruiseSpeedMps: 10 }),
      vehicle(graph, { id: 'hazard', s: 30, speedMps: 0, cruiseSpeedMps: 0 }),
    ],
    occluders: [{
      id: 'screen',
      obb: {
        center: { x: 15, z: 0 },
        lengthM: 1,
        widthM: 6,
        heightM: 2.5,
        headingRad: 0,
      },
    }],
  });
}

function speedAt(trace: SimTrace, actorId: string, t: number): number {
  const index = trace.ticks.t.findIndex((sample) => Math.abs(sample - t) < 1e-9);
  expect(index).toBeGreaterThanOrEqual(0);
  return trace.ticks.actors[actorId]!.speedMps[index]!;
}

describe('ego hazard perception profile', () => {
  it('gates reaction on forward visibility while preserving the legacy omniscient path', () => {
    const input = occludedLeaderScenario();
    const sensor = runSimulation(input, {
      graph,
      guards: 'collect',
      egoControllerProfile: 'sensor-limited',
    }).trace;
    const legacy = runSimulation(input, {
      graph,
      guards: 'collect',
      egoControllerProfile: 'omniscient-legacy',
    }).trace;

    // The screen fully blocks the leader at 0.5 s. A sensor-limited ego holds
    // authored cruise; the historical governor has already reacted to truth.
    expect(speedAt(sensor, 'ego', 0.5)).toBeCloseTo(10, 8);
    expect(speedAt(legacy, 'ego', 0.5)).toBeLessThan(9);

    // Once the ego clears the screen, the same unchanged governor can react.
    expect(speedAt(sensor, 'ego', 2)).toBeLessThan(10);
  });

  it('stamps the default and explicit legacy controller profiles', () => {
    const input = occludedLeaderScenario();
    expect(runSimulation(input, { graph, guards: 'collect' }).trace.header.ego)
      .toEqual({ controllerProfile: 'sensor-limited' });
    expect(runSimulation(input, {
      graph,
      guards: 'collect',
      egoControllerProfile: 'omniscient-legacy',
    }).trace.header.ego).toEqual({ controllerProfile: 'omniscient-legacy' });
  });
});
