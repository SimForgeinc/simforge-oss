/**
 * Scenario builders shared by the tests. Everything is expressed through the
 * public `SimScenarioInput` surface so the fixtures double as worked examples
 * of the contract an adapter has to produce.
 */

import { toSceneXZ } from '../../frames.js';
import { buildLaneGraph, type LaneGraph } from '../../node.js';
import { parseSimScenarioInput, type SimScenarioInput, type SimScenarioInputSpec } from '../../schema/input.js';
import { LANE_LEFT, LANE_RIGHT, syntheticTopology } from './synthetic-map.js';

export function syntheticGraph(): LaneGraph {
  return buildLaneGraph(syntheticTopology());
}

/** Scene-frame pose for a point on a straight, east-bound fixture lane. */
export function poseOnLane(graph: LaneGraph, rsl: string, s: number): { x: number; z: number; headingRad: number } {
  const [x, y, headingRad] = graph.sampleLane(rsl, s, false);
  const scene = toSceneXZ({ x: x!, y: y! });
  return { x: scene.x, z: scene.z, headingRad: headingRad! };
}

export interface VehicleOpts {
  id: string;
  rsl?: string;
  s: number;
  speedMps: number;
  cruiseSpeedMps?: number;
  rules?: Partial<NonNullable<SimScenarioInputSpec['actors'][number]['behavior']['rules']>>;
  dims?: { l: number; w: number; h: number };
  presentAtStart?: boolean;
}

export function vehicle(graph: LaneGraph, o: VehicleOpts): SimScenarioInputSpec['actors'][number] {
  const rsl = o.rsl ?? LANE_LEFT;
  return {
    id: o.id,
    kind: 'vehicle',
    dims: o.dims ?? { l: 4.5, w: 1.9, h: 1.5 },
    initial: {
      laneRef: { rsl, s: o.s, tFrac: 0 },
      pose: poseOnLane(graph, rsl, o.s),
      speedMps: o.speedMps,
    },
    behavior: {
      rules: o.rules,
      route: { kind: 'follow', startRsl: rsl, turns: [], maxLengthM: 2000 },
      cruiseSpeedMps: o.cruiseSpeedMps,
    },
    presentAtStart: o.presentAtStart ?? true,
  };
}

export function scenario(
  partial: Partial<SimScenarioInputSpec> & Pick<SimScenarioInputSpec, 'actors'>,
): SimScenarioInput {
  return parseSimScenarioInput({
    mapId: 'synthetic-straight',
    clipSeconds: 20,
    warmupSeconds: 5,
    dt: 0.02,
    seed: 'fixture',
    physics: { mode: 'dynamic-v1' },
    ...partial,
  });
}

export { LANE_LEFT, LANE_RIGHT };
