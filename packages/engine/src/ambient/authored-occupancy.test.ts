import { describe, expect, it } from 'vitest';
import {
  buildSumoAuthoredOccupancies,
  buildSumoRoadOccupancyIndex,
  sumoAuthoredOccupancySourcesAt,
  type SumoAuthoredOccupancySource,
} from './authored-occupancy.js';
import { sumoNetworkToScene, sumoSceneToNetwork } from './sumo.js';

const TRANSFORM = {
  translationX: 500,
  translationY: -1_500,
  rotationDegrees: 12,
  scale: 1,
  invertY: true,
} as const;

const NETWORK = `<net><edge id="road"><lane id="road_0" width="4" shape="0,0 100,0"/></edge></net>`;
const ROADS = buildSumoRoadOccupancyIndex(NETWORK, {
  translationX: 0,
  translationY: 0,
  rotationDegrees: 0,
  scale: 1,
  invertY: false,
});

function source(overrides: Partial<SumoAuthoredOccupancySource> & Pick<SumoAuthoredOccupancySource, 'id' | 'kind'>): SumoAuthoredOccupancySource {
  return {
    x: 50,
    z: 0,
    headingRad: 0,
    speedMps: 0,
    lengthM: 4.8,
    widthM: 1.9,
    static: false,
    present: true,
    ...overrides,
  };
}

describe('shared SUMO authored occupancy', () => {
  it('mirrors static buses, stalled cars, crossing VRUs, cyclists and construction barriers', () => {
    const proxies = buildSumoAuthoredOccupancies([
      source({ id: 'bus', kind: 'bus', static: true, lengthM: 12, widthM: 2.55 }),
      source({ id: 'stalled', kind: 'car', static: true }),
      source({ id: 'crashed', kind: 'car', static: false, speedMps: 0 }),
      source({ id: 'pedestrian', kind: 'pedestrian', x: 30, z: 6, headingRad: -Math.PI / 2, speedMps: 2, lengthM: .6, widthM: .6 }),
      source({ id: 'cyclist', kind: 'bicycle', x: 40, z: 5, headingRad: -Math.PI / 2, speedMps: 3, lengthM: 1.8, widthM: .6 }),
      source({ id: 'barrier', kind: 'static_object', x: 60, z: 1.5, static: true, lengthM: 2, widthM: .5 }),
    ], ROADS);

    expect(proxies.map(({ id, kind }) => ({ id, kind }))).toEqual([
      { id: 'bus', kind: 'obstacle' },
      { id: 'stalled', kind: 'obstacle' },
      { id: 'crashed', kind: 'vehicle' },
      { id: 'pedestrian', kind: 'pedestrian' },
      { id: 'cyclist', kind: 'bicycle' },
      { id: 'barrier', kind: 'obstacle' },
    ]);
    expect(proxies.every((proxy) => proxy.id === 'pedestrian' || proxy.id === 'cyclist' || proxy.speedMps === 0)).toBe(true);
  });

  it('does not snap off-road scenery or a stationary off-road worker onto traffic lanes', () => {
    const proxies = buildSumoAuthoredOccupancies([
      source({ id: 'tree', kind: 'static_object', x: 50, z: 12, static: true, lengthM: 2, widthM: 2 }),
      source({ id: 'worker', kind: 'pedestrian', x: 50, z: 7, static: true, lengthM: .6, widthM: .6 }),
      source({ id: 'walking-worker', kind: 'pedestrian', x: 50, z: 7, headingRad: 0, speedMps: 1.4, lengthM: .6, widthM: .6 }),
    ], ROADS);
    expect(proxies).toEqual([]);
  });

  it('keeps stationary vulnerable users on a road and removes absent actors', () => {
    const proxies = buildSumoAuthoredOccupancies([
      source({ id: 'waiting-pedestrian', kind: 'pedestrian', speedMps: 0, lengthM: .6, widthM: .6 }),
      source({ id: 'gone', kind: 'car', present: false }),
    ], ROADS);
    expect(proxies.map((proxy) => proxy.id)).toEqual(['waiting-pedestrian']);
  });

  it('preserves scene x/z through the exact SUMO coordinate round trip', () => {
    const scene = { x: 552.19, z: -1582.44 };
    const restored = sumoNetworkToScene(sumoSceneToNetwork(scene, TRANSFORM), TRANSFORM);
    expect(restored.x).toBeCloseTo(scene.x, 9);
    expect(restored.z).toBeCloseTo(scene.z, 9);
  });
});

describe('sampled SUMO occupancy sources', () => {
  it('never hands the blank world clock body to SUMO', () => {
    const track = (x: number) => ({
      x: [x], z: [0], headingRad: [0], speedMps: [0], lateralOffsetM: [0], laneRsl: [null], s: [0], present: [1],
    });
    const trace = {
      header: {
        actorMetadata: {
          'ambient-world-seed': { kind: 'static_object', dims: { l: 1, w: 1, h: 1 }, static: true, tags: ['ambient:internal-clock'] },
          ego: { kind: 'car', dims: { l: 4.6, w: 1.9, h: 1.5 }, static: false, tags: ['catalog:vehicle.sedan'] },
        },
      },
      ticks: { t: [0], actors: { 'ambient-world-seed': track(0), ego: track(50) } },
    } as unknown as Parameters<typeof sumoAuthoredOccupancySourcesAt>[0];
    expect(sumoAuthoredOccupancySourcesAt(trace, 0).map((item) => item.id)).toEqual(['ego']);
  });
});
