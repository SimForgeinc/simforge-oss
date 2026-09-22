/**
 * Generator for the authored golden-trace inputs on Richmond Field Station
 * (the committed CI closure). Run once to (re)create
 * `fixtures/golden-traces/inputs/rfs-*.input.json`; the corpus then treats
 * them as committed inputs. Each case targets one behaviour the engine must
 * keep byte-stable: a U-turn by a car and by a truck (turn geometry at the
 * limit of a class), stop-and-go with an eased stop at the route end, walkers
 * crossing in front of a car, and a car driven into a building (static map
 * colliders).
 *
 *   pnpm --filter @simforge-oss/cli exec node --conditions=development --import tsx scripts/golden-traces-cases.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { canonicalJsonPretty } from '@simforge-oss/scenario/canonical-json';
import { parseSimScenarioInput } from '@simforge-oss/engine';
import { createSimulationMapBundle, readInstalledMapClosureFiles } from '@simforge-oss/compiler/node';

import { GOLDEN_ROOT } from '../src/determinism/golden-traces.js';

const MAP = 'richmond-field-station';
const bundle = await createSimulationMapBundle(await readInstalledMapClosureFiles(path.join(GOLDEN_ROOT, 'maps', MAP), MAP));
const graph = bundle.graph as unknown as {
  sampleLane(rsl: string, s: number, reversed?: boolean | null): Float64Array;
  nominalReversed(rsl: string): boolean | null;
  followRoute(start: string, turns: string[], maxLengthM: number, startReversed?: boolean | null, strict?: boolean | null): string[] | null;
};

const CAR = { l: 4.6, w: 1.85, h: 1.5 };
const TRUCK = { l: 8.5, w: 2.5, h: 3.3 };
const PEDESTRIAN = { l: 0.6, w: 0.6, h: 1.75 };
const RULES = { obeySignals: true, yieldToVehicles: true, yieldToPedestrians: true, collisionAvoidance: true, aggression: 0.5, speedFactor: 1 };

/** Scene pose `{x, z, headingRad}` at traversal distance `s` along `rsl` (scene = (x, -y)). */
function poseOn(rsl: string, s: number): { x: number; z: number; headingRad: number } {
  const [x, y, heading] = graph.sampleLane(rsl, s, graph.nominalReversed(rsl) ?? false);
  return { x: x!, z: -y!, headingRad: heading! };
}

function vehicle(id: string, kind: 'car' | 'truck', lanes: string[], s: number, speedMps: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    kind,
    dims: kind === 'truck' ? TRUCK : CAR,
    initial: { laneRef: { rsl: lanes[0], s, tFrac: 0 }, pose: poseOn(lanes[0]!, s), speedMps },
    behavior: { rules: RULES, route: { kind: 'lanePath', lanes }, cruiseSpeedMps: speedMps },
    presentAtStart: true,
    tags: [`class:${kind}`],
    ...extra,
  };
}

function base(clipSeconds: number, seed: string, actors: unknown[], interactions: unknown[] = []) {
  return parseSimScenarioInput({
    mapId: MAP,
    clipSeconds,
    warmupSeconds: 0,
    dt: 0.02,
    seed,
    actors,
    interactions,
    physics: { mode: 'dynamic-v1' },
  });
}

const uturn = ['51:0:-1', '104:0:-1', '70:0:1'];
const straight = graph.followRoute('51:0:-1', ['Straight', 'Straight', 'Straight'], 400, null, false) ?? ['51:0:-1'];

const cases: Record<string, unknown> = {
  'rfs-uturn-car': base(30, 'golden:rfs-uturn-car', [vehicle('ego', 'car', uturn, 120, 7)]),
  'rfs-uturn-truck': base(34, 'golden:rfs-uturn-truck', [vehicle('truck', 'truck', uturn, 110, 6)]),
  'rfs-stop-and-go': base(20, 'golden:rfs-stop-and-go', [vehicle('ego', 'car', straight, 5, 11)], [
    { id: 'halt', actorId: 'ego', trigger: { kind: 'at', t: 4 }, verb: 'speed', target: { mode: 'stop' }, dynamics: { shape: 'cubic', constraint: 'time', value: 2.5 } },
    { id: 'resume', actorId: 'ego', trigger: { kind: 'at', t: 9 }, verb: 'speed', target: { mode: 'absolute', value: 9 }, dynamics: { shape: 'step', constraint: 'time', value: 2 } },
  ]),
  'rfs-walkers-crossing': (() => {
    const lanes = straight;
    const car = vehicle('ego', 'car', lanes, 5, 9);
    const at = poseOn(lanes[0]!, 60);
    const nx = -Math.sin(at.headingRad);
    const nz = Math.cos(at.headingRad);
    const walker = (id: string, along: number, speed: number, startSide: 1 | -1) => {
      const p = poseOn(lanes[0]!, along);
      const from = { x: p.x + startSide * nx * 7, z: p.z + startSide * nz * 7 };
      const to = { x: p.x - startSide * nx * 7, z: p.z - startSide * nz * 7 };
      return {
        id,
        kind: 'pedestrian',
        dims: PEDESTRIAN,
        initial: { pose: { ...from, headingRad: Math.atan2(to.z - from.z, to.x - from.x) }, speedMps: speed },
        behavior: { rules: { ...RULES, yieldToVehicles: false, yieldToPedestrians: false, collisionAvoidance: false }, route: { kind: 'polyline', points: [from, to] } },
        presentAtStart: true,
        tags: ['class:pedestrian'],
      };
    };
    return base(16, 'golden:rfs-walkers', [car, walker('ped-a', 55, 1.4, 1), walker('ped-b', 65, 1.1, -1), walker('ped-c', 80, 1.7, 1)]);
  })(),
  // Building canonical-master/2448 (42 m × 31 m, centre (113.6, −107.6)): drive west into it.
  'rfs-collider-building': base(10, 'golden:rfs-collider', [{
    id: 'ego',
    kind: 'car',
    dims: CAR,
    initial: { pose: { x: 160, z: -107.6, headingRad: Math.PI }, speedMps: 10 },
    behavior: {
      rules: { ...RULES, obeySignals: false, collisionAvoidance: false },
      route: { kind: 'polyline', points: [{ x: 160, z: -107.6 }, { x: 60, z: -107.6 }] },
      cruiseSpeedMps: 10,
    },
    presentAtStart: true,
    tags: ['class:car'],
  }]),
};

const out = path.join(GOLDEN_ROOT, 'inputs');
mkdirSync(out, { recursive: true });
for (const [id, input] of Object.entries(cases)) {
  writeFileSync(path.join(out, `${id}.input.json`), `${canonicalJsonPretty(input)}\n`);
  console.log(id);
}
