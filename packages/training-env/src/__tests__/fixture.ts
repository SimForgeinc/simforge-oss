import { parseSimScenarioInput, toSceneXZ, type LaneGraph, type SimScenarioInput, type SimScenarioInputSpec } from '@simforge-oss/engine';
import { buildLaneGraph } from '@simforge-oss/engine/node';

import { LANE_LEFT, LANE_RIGHT, syntheticTopology } from './synthetic-map.js';

export function syntheticGraph(): LaneGraph {
  return buildLaneGraph(syntheticTopology());
}

export function vehicle(graph: LaneGraph, o: { id: string; rsl?: string; s: number; speedMps: number; cruiseSpeedMps?: number }): SimScenarioInputSpec['actors'][number] {
  const rsl = o.rsl ?? LANE_LEFT;
  const [x, y, headingRad] = graph.sampleLane(rsl, o.s, false);
  const scene = toSceneXZ({ x: x!, y: y! });
  return {
    id: o.id,
    kind: 'vehicle',
    dims: { l: 4.5, w: 1.9, h: 1.5 },
    initial: { laneRef: { rsl, s: o.s, tFrac: 0 }, pose: { x: scene.x, z: scene.z, headingRad: headingRad! }, speedMps: o.speedMps },
    behavior: { route: { kind: 'follow', startRsl: rsl, turns: [], maxLengthM: 2000 }, cruiseSpeedMps: o.cruiseSpeedMps },
    presentAtStart: true,
  };
}

export function scenario(partial: Partial<SimScenarioInputSpec> & Pick<SimScenarioInputSpec, 'actors'>): SimScenarioInput {
  return parseSimScenarioInput({
    mapId: 'synthetic-straight',
    clipSeconds: 4,
    warmupSeconds: 1,
    dt: 0.02,
    seed: 'fixture',
    physics: { mode: 'dynamic-v1' },
    ...partial,
  });
}

export { LANE_LEFT, LANE_RIGHT };
