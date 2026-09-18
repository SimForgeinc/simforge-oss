/**
 * Which production scenarios actually crash — without rendering any of them.
 *
 * `lowerOpenScenarioToNative` is the same motion lowering the native render
 * lane uses, and it needs nothing but the OpenSCENARIO text: no map bundle, no
 * GPU, no engine process. Sampling it on a fixed schedule gives every actor's
 * pose per tick, so contact is a geometry question over oriented boxes. A
 * 20-second scenario screens in milliseconds instead of the ~15 minutes an
 * eight-camera render costs, which is the difference between screening a corpus
 * and guessing at it.
 *
 * Usage: tsx collision-screen.ts <candidates.json> [tickHz]
 *   candidates.json: [{ revisionId, packageId, name, xoscPath, dims }]
 *   dims: optional { [actorId]: { length, width } } from the authored roles.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// The package's `/native` subpath does not re-export the lowering, so this
// reaches the module directly.
import { lowerOpenScenarioToNative } from '../../packages/render/src/native/lowering.js';
import type { NativeSceneState } from '../../packages/render/src/native/lowering.js';
import { FIXED_SCHEDULE_V1_SCHEMA } from '../../packages/render/src/schedule.js';

type Dims = { readonly length: number; readonly width: number };

interface Candidate {
  readonly revisionId: string;
  readonly packageId: string;
  readonly name: string;
  readonly xoscPath: string;
  readonly dims?: Record<string, Dims>;
}

/** Fallbacks for actors the authored document does not size explicitly. */
const CLASS_DIMS: Record<string, Dims> = {
  car: { length: 4.7, width: 1.82 },
  van: { length: 5.15, width: 2.0 },
  truck: { length: 7.5, width: 2.4 },
  bus: { length: 12.0, width: 2.55 },
  motorcycle: { length: 2.1, width: 0.8 },
  bicycle: { length: 1.8, width: 0.65 },
  pedestrian: { length: 0.6, width: 0.6 },
};

/** Corner offsets of an actor's footprint, in its own frame. */
function corners(dims: Dims): Array<readonly [number, number]> {
  const halfLength = dims.length / 2;
  const halfWidth = dims.width / 2;
  return [[halfLength, halfWidth], [halfLength, -halfWidth], [-halfLength, -halfWidth], [-halfLength, halfWidth]];
}

interface Footprint {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly yaw: number;
  readonly dims: Dims;
  readonly points: Array<readonly [number, number]>;
}

function footprint(id: string, x: number, y: number, yaw: number, dims: Dims): Footprint {
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  const points = corners(dims).map(([forward, left]) =>
    [x + forward * cos - left * sin, y + forward * sin + left * cos] as const);
  return { id, x, y, yaw, dims, points };
}

/**
 * Separating-axis overlap for two rectangles. Axis-aligned distance is not
 * enough: two 4.7 m cars can have 3 m between centres and still be clear if
 * they are side by side, or interpenetrating if they are nose to tail.
 */
function overlaps(left: Footprint, right: Footprint): boolean {
  for (const shape of [left, right]) {
    const axes = [
      [Math.cos(shape.yaw), Math.sin(shape.yaw)] as const,
      [-Math.sin(shape.yaw), Math.cos(shape.yaw)] as const,
    ];
    for (const [ax, ay] of axes) {
      let leftMin = Infinity, leftMax = -Infinity, rightMin = Infinity, rightMax = -Infinity;
      for (const [px, py] of left.points) {
        const projection = px * ax + py * ay;
        leftMin = Math.min(leftMin, projection);
        leftMax = Math.max(leftMax, projection);
      }
      for (const [px, py] of right.points) {
        const projection = px * ax + py * ay;
        rightMin = Math.min(rightMin, projection);
        rightMax = Math.max(rightMax, projection);
      }
      if (leftMax < rightMin || rightMax < leftMin) return false;
    }
  }
  return true;
}

function schedule(endSeconds: number, tickHz: number) {
  return [{
    schema: FIXED_SCHEDULE_V1_SCHEMA,
    sourceId: 'screen',
    startSeconds: 0,
    endSeconds,
    framesPerSecond: tickHz,
    frameCount: Math.max(1, Math.round(endSeconds * tickHz)),
  }] as const;
}

function dimsFor(candidate: Candidate, actorId: string, actorClass: string): Dims {
  return candidate.dims?.[actorId] ?? CLASS_DIMS[actorClass] ?? CLASS_DIMS.car!;
}

/** Scene states carry native-frame coordinates: position is [x, up, -y]. */
function planar(state: NativeSceneState['actors'][number]): { x: number; y: number; yaw: number } {
  const [x, , negativeY] = state.transform.position;
  // rotation is a quaternion about the up axis only, so yaw = 2*atan2(qy, qw).
  const yaw = 2 * Math.atan2(state.transform.rotation[1]!, state.transform.rotation[3]!);
  return { x: x!, y: -negativeY!, yaw };
}

export interface ScreenResult {
  readonly revisionId: string;
  readonly packageId: string;
  readonly name: string;
  readonly actors: number;
  readonly moving: number;
  readonly ticks: number;
  readonly contacts: Array<{ pair: [string, string]; firstT: number; lastT: number; classes: [string, string] }>;
  readonly closestApproachM: number;
  readonly closestPair: [string, string] | null;
}

export function screen(candidate: Candidate, tickHz: number): ScreenResult {
  const xosc = readFileSync(candidate.xoscPath, 'utf8');
  const sha = createHash('sha256').update(xosc).digest('hex');
  // stopTime bounds the lowering; probe it by lowering a single frame first.
  const probe = lowerOpenScenarioToNative(xosc, sha, schedule(0.001, 1) as never);
  const endSeconds = Math.max(0.5, probe.plan.stopTimeS - probe.plan.warmupSeconds - 1e-6);
  const lowered = lowerOpenScenarioToNative(xosc, sha, schedule(endSeconds, tickHz) as never);

  const classOf = new Map<string, string>();
  const movers = new Set<string>();
  const contacts = new Map<string, { pair: [string, string]; firstT: number; lastT: number }>();
  let closest = Infinity;
  let closestPair: [string, string] | null = null;

  lowered.states.forEach((state, tick) => {
    const t = lowered.frameTimes[tick]!;
    const prints: Footprint[] = [];
    for (const actor of state.actors) {
      if (actor.kind === 'despawn') continue;
      classOf.set(actor.id, actor.actorClass);
      const speed = Math.hypot(actor.velocity[0], actor.velocity[2]);
      if (speed > 0.5) movers.add(actor.id);
      const { x, y, yaw } = planar(actor);
      prints.push(footprint(actor.id, x, y, yaw, dimsFor(candidate, actor.id, actor.actorClass)));
    }
    for (let i = 0; i < prints.length; i += 1) {
      for (let j = i + 1; j < prints.length; j += 1) {
        const a = prints[i]!;
        const b = prints[j]!;
        const gap = Math.hypot(a.x - b.x, a.y - b.y)
          - (Math.max(a.dims.length, a.dims.width) + Math.max(b.dims.length, b.dims.width)) / 2;
        if (gap < closest) {
          closest = gap;
          closestPair = [a.id, b.id];
        }
        if (!overlaps(a, b)) continue;
        const key = `${a.id}|${b.id}`;
        const existing = contacts.get(key);
        if (existing) existing.lastT = t;
        else contacts.set(key, { pair: [a.id, b.id], firstT: t, lastT: t });
      }
    }
  });

  return {
    revisionId: candidate.revisionId,
    packageId: candidate.packageId,
    name: candidate.name,
    actors: classOf.size,
    moving: movers.size,
    ticks: lowered.states.length,
    contacts: [...contacts.values()].map((entry) => ({
      ...entry,
      classes: [classOf.get(entry.pair[0]) ?? '?', classOf.get(entry.pair[1]) ?? '?'] as [string, string],
    })),
    closestApproachM: Math.round(closest * 1000) / 1000,
    closestPair,
  };
}

const candidates: Candidate[] = JSON.parse(readFileSync(process.argv[2]!, 'utf8'));
const tickHz = Number(process.argv[3] ?? '20');
const results: ScreenResult[] = [];
for (const candidate of candidates) {
  try {
    const result = screen(candidate, tickHz);
    results.push(result);
    const worst = result.contacts.length > 0
      ? `CONTACT x${result.contacts.length} first=${result.contacts[0]!.firstT.toFixed(2)}s ${result.contacts[0]!.classes.join('/')}`
      : `clear (closest ${result.closestApproachM.toFixed(2)} m)`;
    console.log(`${result.name.padEnd(46)} actors=${String(result.actors).padStart(2)} moving=${String(result.moving).padStart(2)} ticks=${String(result.ticks).padStart(4)}  ${worst}`);
  } catch (error) {
    console.log(`${candidate.name.padEnd(46)} FAILED ${String(error).slice(0, 120)}`);
  }
}
const outPath = '/tmp/collision-screen-results.json';
writeFileSync(outPath, JSON.stringify(results, null, 1));
console.log(`\nresults: ${outPath}`);
