import { expect, it } from 'vitest';
import { buildLaneGraph, runSimulation } from '@simforge-oss/engine';
import { ScenarioTemplateV2Schema } from '@simforge-oss/scenario';
import { deriveMapIndexFromTopology } from './anchor/index.js';
import { materializeMapBound } from './map-bound.js';
import type { MapBundle } from './types.js';

it('retains an explicit world route and authored speed control instead of inventing a straight path', () => {
  const topology = { source: { xodrSha256: 'a'.repeat(64) }, lanes: {}, gates: [], junctions: {} };
  const map = {
    mapId: 'new-map', topology, graph: buildLaneGraph(topology),
    index: deriveMapIndexFromTopology({ schemaVersion: 3, lanes: {}, gates: [], junctions: {} }, { mapId: 'new-map' }),
    derived: {}, catalog: {}, signalCatalog: { heads: [], controllers: [], junctionControllers: {}, applicability: [], roadControls: [], speedLimits: [] },
  } as unknown as MapBundle;
  const points = [{ x: 0, z: 0 }, { x: 15, z: 0 }, { x: 15, z: -30 }];
  const template = ScenarioTemplateV2Schema.parse({
    scenarioVersion: 2,
    meta: { name: 'Retained world route', createdAt: '2026-09-06T00:00:00Z', modifiedAt: '2026-09-06T00:00:00Z', appVersion: 'test' },
    sourceMap: { mapId: 'new-map', mapName: 'New map' }, anchor: { pin: { mapId: 'new-map' }, features: [] },
    roles: [{ id: 'ego', kind: 'scene_absolute', actor: { class: 'car', catalogId: 'vehicle.sedan' }, pose: { position: { x: 0, y: 0, z: 0 }, headingRad: 0 }, initialRoute: { mode: 'worldPath', points }, initialSpeedKph: 18 }],
    choreography: { clipSeconds: 8, warmupSeconds: 0, interactions: [{ id: 'stop', actor: 'ego', trigger: { kind: 'at', t: 5 }, verb: 'speed', target: { mode: 'stop' }, dynamics: { shape: 'linear', constraint: 'time', value: 1 } }] },
  });
  const result = materializeMapBound(template, map, { drawIndex: -1 });
  expect(result.manifest.feasible).toBe(true);
  const input = result.input;
  expect(input.actors[0]?.behavior.route).toEqual({ kind: 'polyline', points });
  expect(input.interactions.some(interaction => interaction.id === 'stop' && interaction.verb === 'speed')).toBe(true);
  const simulated = runSimulation(input, { graph: map.graph });
  const track = simulated.trace.ticks.actors.ego!;
  expect(Math.abs(track.x.at(-1)! - 15)).toBeLessThan(1);
  expect(track.y.at(-1)).toBeGreaterThan(5);
  expect(track.speedMps.at(-1)).toBeLessThan(.1);
});
