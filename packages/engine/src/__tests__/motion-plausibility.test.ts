/**
 * Physical plausibility of engine motion around stops, end to end through the
 * native runtime: many seeded scenarios where wheeled bodies brake to a
 * standstill (route ends, a stopped leader, tight U-turn and zig-zag drawn
 * paths that end mid-curve with the steering wound on) and then sit there.
 *
 * Every trace is checked twice: by the engine's own audit (`evaluateTrace`
 * must carry no `implausible_motion` finding and the run no
 * `implausible_motion` issue) and by an independent re-derivation here of the
 * non-holonomic envelope, the tyre limits and jerk. A stopped car that turns
 * in place, turns faster than rolling allows, is dragged backwards by its
 * brakes or is placed rather than driven fails both.
 *
 * Requires the built addon (`pnpm --filter @simforge-oss/native-runtime build:node`).
 */

import { describe, expect, it } from 'vitest';

import { evaluateTrace, runSimulation } from '../node.js';
import type { ActorKind, SimScenarioInputSpec } from '../schema/input.js';
import type { SimTrace } from '../trace/trace.js';
import { scenario, syntheticGraph, vehicle } from './fixtures/scenarios.js';
import { LANE_DEAD_END } from './fixtures/synthetic-map.js';

const graph = syntheticGraph();

/** Class wheelbase and steering lock (`simforge-core::physics::profile`). */
const WHEELED: Partial<Record<ActorKind, { wheelbaseM: number; maxSteerRad: number }>> = {
  vehicle: { wheelbaseM: 2.7, maxSteerRad: 0.58 },
  car: { wheelbaseM: 2.7, maxSteerRad: 0.58 },
  van: { wheelbaseM: 3.35, maxSteerRad: 0.54 },
  truck: { wheelbaseM: 5.2, maxSteerRad: 0.44 },
  bus: { wheelbaseM: 6.0, maxSteerRad: 0.46 },
  bicycle: { wheelbaseM: 1.08, maxSteerRad: 0.7 },
};
const G = 9.80665;

/** Deterministic mulberry32 so each seed is one reproducible case. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type ActorSpec = SimScenarioInputSpec['actors'][number];

function drawn(id: string, kind: ActorKind, points: Array<{ x: number; y: number }>, speedMps: number): ActorSpec {
  const [p0, p1] = points as [{ x: number; y: number }, { x: number; y: number }];
  return {
    id,
    kind,
    dims: kind === 'bicycle' ? { l: 1.8, w: 0.6, h: 1.7 } : kind === 'truck' || kind === 'bus' ? { l: 10, w: 2.5, h: 3.2 } : { l: 4.5, w: 1.9, h: 1.5 },
    initial: {
      pose: { x: p0.x, z: -p0.y, headingRad: Math.atan2(p1.y - p0.y, p1.x - p0.x) },
      speedMps,
    },
    behavior: {
      route: { kind: 'polyline', points: points.map((p) => ({ x: p.x, z: -p.y })) },
      cruiseSpeedMps: speedMps,
    },
    presentAtStart: true,
  };
}

/** Out along +x, a U-turn of radius `r`, back along -x; ends partway round a second bend. */
function uTurnPath(x0: number, y0: number, straightM: number, r: number, endAngleRad: number): Array<{ x: number; y: number }> {
  const pts: Array<{ x: number; y: number }> = [];
  for (let s = 0; s <= straightM; s += 2) pts.push({ x: x0 + s, y: y0 });
  const cx = x0 + straightM;
  const cy = y0 + r;
  for (let a = -Math.PI / 2 + 0.2; a <= Math.PI / 2; a += 0.2) pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  for (let s = 2; s <= straightM * 0.6; s += 2) pts.push({ x: cx - s, y: y0 + 2 * r });
  // A final bend the body stops in, wheels turned.
  const bx = cx - straightM * 0.6;
  for (let a = 0.15; a <= endAngleRad; a += 0.15) pts.push({ x: bx - r * Math.sin(a), y: y0 + 2 * r - r * (1 - Math.cos(a)) });
  return pts;
}

function zigZagPath(x0: number, y0: number, lengthM: number, amplitude: number, wavelength: number): Array<{ x: number; y: number }> {
  const pts: Array<{ x: number; y: number }> = [];
  for (let s = 0; s <= lengthM; s += 1.5) pts.push({ x: x0 + s, y: y0 + amplitude * Math.sin((2 * Math.PI * s) / wavelength) });
  return pts;
}

function stopCase(seed: number) {
  const r = rng(seed);
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(r() * items.length)]!;
  const kind = pick(['vehicle', 'car', 'van', 'truck', 'bus', 'bicycle'] as const);
  const speed = kind === 'bicycle' ? 3 + 4 * r() : 4 + 12 * r();
  const shape = pick(['route-end', 'leader', 'u-turn', 'zig-zag', 'walker'] as const);
  let actors: ActorSpec[];
  if (shape === 'route-end') {
    // A route that simply runs out — a dead-end lane or a drawn straight — at
    // speed: the body must brake to the end rather than stop dead there.
    if (r() < 0.5) {
      const ego = vehicle(graph, { id: 'ego', rsl: LANE_DEAD_END, s: 2 + 10 * r(), speedMps: Math.min(speed, 9), cruiseSpeedMps: Math.min(speed, 9) });
      actors = [{ ...ego, kind, behavior: { ...ego.behavior, route: { kind: 'lanePath', lanes: [LANE_DEAD_END] } } }];
    } else {
      const lengthM = 40 + 160 * r();
      actors = [drawn('ego', kind, [{ x: 20, y: 0 }, { x: 20 + lengthM, y: 0.4 * r() }], speed)];
    }
  } else if (shape === 'leader') {
    // A leader stops at the end of a dead-end lane; the follower queues
    // behind it and stops too.
    const lead = vehicle(graph, { id: 'lead', rsl: LANE_DEAD_END, s: 25 + 10 * r(), speedMps: 5, cruiseSpeedMps: 5 });
    const ego = vehicle(graph, { id: 'ego', rsl: LANE_DEAD_END, s: 2 + 5 * r(), speedMps: Math.min(speed, 9), cruiseSpeedMps: Math.min(speed, 9) });
    const deadEnd = { kind: 'lanePath' as const, lanes: [LANE_DEAD_END] };
    actors = [
      { ...lead, behavior: { ...lead.behavior, route: deadEnd } },
      { ...ego, kind, behavior: { ...ego.behavior, route: deadEnd } },
    ];
  } else if (shape === 'u-turn') {
    // Out-and-back: the route passes within a few metres of itself, and ends
    // part-way round a final bend.
    const radius = kind === 'truck' || kind === 'bus' ? 14 + 4 * r() : 6 + 5 * r();
    actors = [drawn('ego', kind, uTurnPath(100, 120 + 40 * r(), 30 + 40 * r(), radius, 0.3 + 1.2 * r()), Math.min(speed, 8))];
  } else if (shape === 'walker') {
    // A walker crosses and reaches the end of its path: it slows to a stop
    // rather than halting from walking pace inside one tick.
    const walker = drawn('ego', 'pedestrian', [{ x: 300, y: -8 }, { x: 300 + 3 * r(), y: 6 + 4 * r() }], 1.2 + 0.6 * r());
    actors = [{ ...walker, dims: { l: 0.5, w: 0.6, h: 1.75 } }];
  } else {
    actors = [drawn('ego', kind, zigZagPath(100, 250, 40 + 60 * r(), 1 + 2.5 * r(), 25 + 20 * r()), Math.min(speed, 10))];
  }
  return { shape, kind: shape === 'walker' ? 'pedestrian' : kind, input: scenario({ seed: `stop-${seed}`, clipSeconds: 60, warmupSeconds: 0, dt: 0.05, actors }) };
}

interface Violation { actor: string; t: number; check: string; measured: number; limit: number }

/** Independent re-derivation of the physical envelope from the published trace. */
function independentAudit(trace: SimTrace, kinds: Record<string, ActorKind>): Violation[] {
  const out: Violation[] = [];
  const t = trace.ticks.t;
  for (const [id, track] of Object.entries(trace.ticks.actors)) {
    // Walkers may turn on the spot; everything else below applies to them too.
    const cls = WHEELED[kinds[id]!];
    const contact = track.physics?.collisionCount ?? [];
    let previousAccel: number | null = null;
    for (let i = 1; i < t.length; i += 1) {
      if (!track.present[i] || !track.present[i - 1] || (contact[i] ?? 0) > 0) {
        previousAccel = null;
        continue;
      }
      const dt = t[i]! - t[i - 1]!;
      const v0 = track.speedMps[i - 1]!;
      const v1 = track.speedMps[i]!;
      const dyaw = Math.abs(Math.atan2(Math.sin(track.headingRad[i]! - track.headingRad[i - 1]!), Math.cos(track.headingRad[i]! - track.headingRad[i - 1]!)));
      const vMax = Math.max(Math.abs(v0), Math.abs(v1)) + 1e-4;
      const envelope = cls ? (vMax * Math.tan(cls.maxSteerRad)) / cls.wheelbaseM : Infinity;
      if (dyaw / dt > envelope * 1.02 + 2e-6 / dt) out.push({ actor: id, t: t[i]!, check: v0 === 0 && v1 === 0 ? 'rotation-at-rest' : 'yaw-envelope', measured: dyaw / dt, limit: envelope });
      const accel = (v1 - v0) / dt;
      if (Math.abs(accel) > 1.5 * G) out.push({ actor: id, t: t[i]!, check: 'accel', measured: accel, limit: 1.5 * G });
      const lateral = !cls ? 0 : 0.5 * (Math.abs(v0) + Math.abs(v1)) * (dyaw / dt);
      if (lateral > 1.5 * G) out.push({ actor: id, t: t[i]!, check: 'lateral', measured: lateral, limit: 1.5 * G });
      if (previousAccel !== null && Math.abs(accel - previousAccel) > 1.5 * G + 4e-4 / dt) out.push({ actor: id, t: t[i]!, check: 'jerk', measured: Math.abs(accel - previousAccel), limit: 1.5 * G });
      previousAccel = accel;
      const motion = track.motionDirection?.[i] ?? 1;
      const u = track.physics?.vxBodyMps[i] ?? v1;
      if (motion === 1 && u < -1e-9) out.push({ actor: id, t: t[i]!, check: 'reversed-without-command', measured: u, limit: 0 });
    }
  }
  return out;
}

describe('motion plausibility around stops', () => {
  const seeds = Array.from({ length: 48 }, (_, i) => 1000 + i);

  it.each(seeds)('seed %i: wheeled bodies stop without turning in place, reversing, or being placed', (seed) => {
    const { shape, kind, input } = stopCase(seed);
    const result = runSimulation(input, { graph });
    const kinds = Object.fromEntries(result.input.actors.map((a) => [a.id, a.kind]));
    const ego = result.trace.ticks.actors['ego']!;

    const violations = independentAudit(result.trace, kinds);
    expect(violations, `${shape}/${kind}`).toEqual([]);

    const evaluation = evaluateTrace(result.trace);
    expect(evaluation.findings.filter((f) => f.code === 'implausible_motion'), `${shape}/${kind}`).toEqual([]);
    expect(evaluation.summary.implausibleMotion).toBe(0);
    expect(result.issues.filter((issue) => issue.code === 'implausible_motion'), `${shape}/${kind}`).toEqual([]);

    // Every case ends with the body at rest: the stop actually happened.
    const last = ego.speedMps.length - 1;
    expect(ego.speedMps[last], `${shape}/${kind} final speed`).toBe(0);
    // And at rest it stays put: no heading or position drift over the hold.
    const restFrom = ego.speedMps.findIndex((v, i) => ego.speedMps.slice(i).every((w) => w === 0));
    expect(restFrom).toBeGreaterThan(0);
    for (let i = restFrom + 1; i <= last; i += 1) {
      expect(Math.abs(ego.headingRad[i]! - ego.headingRad[restFrom]!), `${shape}/${kind} heading drift at rest`).toBeLessThanOrEqual(2e-6);
      expect(Math.hypot(ego.x[i]! - ego.x[restFrom]!, ego.y[i]! - ego.y[restFrom]!), `${shape}/${kind} drift at rest`).toBeLessThanOrEqual(2e-3);
    }
  });

  it('flags a trace in which a stopped car turns in place', () => {
    const input = scenario({ seed: 'spin-injection', clipSeconds: 30, warmupSeconds: 0, dt: 0.05, actors: [drawn('ego', 'car', [{ x: 20, y: 0 }, { x: 80, y: 0 }], 8)] });
    const { trace } = runSimulation(input, { graph });
    expect(evaluateTrace(trace).findings.filter((f) => f.code === 'implausible_motion')).toEqual([]);
    const ego = trace.ticks.actors['ego']!;
    const last = ego.headingRad.length - 1;
    // Rotate the parked body a little more every tick for the last second:
    // the motion the editor used to show.
    const spun = structuredClone(trace);
    const track = spun.ticks.actors['ego']!;
    for (let i = last - 20, k = 1; i <= last; i += 1, k += 1) track.headingRad[i] = ego.headingRad[last - 21]! + 0.02 * k;
    for (let i = last - 20; i <= last; i += 1) track.speedMps[i] = 0;
    const evaluation = evaluateTrace(spun);
    expect(evaluation.verdict).toBe('reject');
    const finding = evaluation.findings.find((f) => f.code === 'implausible_motion');
    expect(finding).toBeDefined();
    const detail = finding!.detail as { findings: Array<{ code: string; actorId: string }> };
    expect(detail.findings.some((f) => f.actorId === 'ego' && f.code === 'rotation_at_rest')).toBe(true);
  });
});
