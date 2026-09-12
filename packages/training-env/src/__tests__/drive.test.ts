/**
 * The live driving contract, end to end through the N-API addon: a held
 * driver command reaches the `dynamic-v1` integrator, the per-frame telemetry
 * a HUD and an audio graph render from is published on truth frames, contact
 * with a solid body is reported as an impulse, and a freehand timed route is
 * still followed now that it is a speed profile rather than choreography.
 * Requires the built addon.
 */
import { describe, expect, it } from 'vitest';

import type { TruthFrame, VehicleTelemetry } from '../truth-stream.js';
import { sessions } from '../node.js';
import { LANE_LEFT, scenario, syntheticGraph, vehicle } from './fixture.js';

const graph = syntheticGraph();
const runtime = sessions();

function playerScenario(extra: Parameters<typeof scenario>[0]['actors'] = []) {
  return scenario({
    clipSeconds: 40,
    metricSubject: 'player',
    actors: [
      vehicle(graph, { id: 'player', rsl: LANE_LEFT, s: 20, speedMps: 0, cruiseSpeedMps: 0 }),
      ...extra,
    ],
  });
}

function latest(frames: readonly TruthFrame[], actorId: string): VehicleTelemetry {
  const frame = frames[frames.length - 1];
  if (!frame) throw new Error('no truth frame was published');
  const actor = frame.actors.find((a) => a.id === actorId);
  if (!actor?.telemetry) throw new Error(`no telemetry for ${actorId}`);
  return actor.telemetry;
}

describe('driver command', () => {
  it('accelerates through the gears, steers, and brakes to a stop', () => {
    const world = runtime.world({ input: playerScenario(), graph, mode: 'live', horizonSeconds: 40 });
    const truth = world.subscribeTruth({ capacity: 4096 });
    let seq = 0;
    const held = (throttle: number, brake: number, steer: number, handbrake = false) =>
      world.setDriverCommand('drive-test', (seq += 1), 'player', { throttle, brake, steer, handbrake });

    expect(held(1, 0, 0).ok).toBe(true);
    world.advance(250);
    const accelerated = latest(truth.frames(), 'player');
    expect(accelerated.speedMps).toBeGreaterThan(10);
    expect(accelerated.gear).toBeGreaterThan(1);
    expect(accelerated.rpm).toBeGreaterThan(1_000);
    expect(accelerated.throttle).toBeGreaterThan(0);
    expect(accelerated.longitudinalG).toBeGreaterThan(0);
    // Four wheels, all rolling forwards with the body.
    expect(accelerated.wheelSpeeds).toHaveLength(4);
    for (const omega of accelerated.wheelSpeeds) expect(omega).toBeGreaterThan(0);

    held(0.4, 0, 0.35);
    world.advance(40);
    const steered = latest(truth.frames(), 'player');
    expect(steered.steer).toBeGreaterThan(0.05);
    expect(steered.steerRad).toBeGreaterThan(0);
    expect(Math.abs(steered.lateralG)).toBeGreaterThan(0.05);
    // The outside wheels of a turn travel further per revolution of the axle.
    expect(steered.wheelSpeeds[1]).toBeGreaterThan(steered.wheelSpeeds[0]!);

    // Braking brings it to a standstill. Sampled as it goes, because a held
    // brake pedal at a standstill is how an automatic takes reverse — the
    // stop is a moment, not a terminal state.
    held(0, 1, 0);
    let rest: VehicleTelemetry | undefined;
    for (let i = 0; i < 400 && !rest; i += 1) {
      world.advance(1);
      const sample = latest(truth.frames(), 'player');
      if (sample.speedMps < 0.2) rest = sample;
    }
    expect(rest, 'the brake should bring the body to a standstill').toBeDefined();
    expect(rest!.brake).toBeGreaterThan(0);
  });

  it('reports a collision impulse when the body hits a parked car', () => {
    const parked = vehicle(graph, { id: 'wall', rsl: LANE_LEFT, s: 120, speedMps: 0 });
    const world = runtime.world({
      input: playerScenario([{ ...parked, static: true }]),
      graph,
      mode: 'live',
      horizonSeconds: 40,
    });
    const truth = world.subscribeTruth({ capacity: 4096 });
    world.setDriverCommand('drive-test', 1, 'player', { throttle: 1, brake: 0, steer: 0, handbrake: false });
    world.advance(500);

    const frames = truth.frames();
    const impulses = frames.map((frame) => frame.actors.find((a) => a.id === 'player')?.telemetry?.collisionImpulseNs ?? 0);
    const peak = Math.max(...impulses);
    expect(peak).toBeGreaterThan(0);
    // Contact stops the car rather than being an annotation on a pass-through.
    const speeds = frames.map((frame) => frame.actors.find((a) => a.id === 'player')?.telemetry?.speedMps ?? 0);
    const atImpact = speeds[impulses.indexOf(peak)]!;
    expect(speeds[speeds.length - 1]!).toBeLessThan(atImpact);
  });

  it('follows a freehand timed route under forces', () => {
    const drawn = {
      id: 'drawn',
      kind: 'car' as const,
      dims: { l: 4.5, w: 1.9, h: 1.5 },
      initial: { pose: { x: 20, z: 0, headingRad: 0 }, speedMps: 8 },
      behavior: {
        route: {
          kind: 'timedPolyline' as const,
          // Scene z is -y: a straight run east along the left lane.
          points: [
            { timeS: 0, x: 20, z: 0 },
            { timeS: 4, x: 60, z: 0 },
            { timeS: 8, x: 100, z: 0 },
          ],
        },
      },
      presentAtStart: true,
    };
    const world = runtime.world({ input: scenario({ clipSeconds: 12, actors: [drawn] }), graph, horizonSeconds: 12 });
    world.advance(400);
    const actor = world.snapshot().actors.find((a) => a.id === 'drawn')!;
    // 8 s of schedule at 10 m/s: the body drives to the last waypoint rather
    // than being placed on it, so it arrives near it, not exactly on it.
    expect(actor.x).toBeGreaterThan(90);
    expect(Math.abs(actor.z)).toBeLessThan(2);
  });
});
