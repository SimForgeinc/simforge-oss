/**
 * Consumer contracts of the native-backed session façades: Gymnasium reset/step
 * semantics, batch parity with single sessions, world-session replay identity
 * and truth-stream framing. Requires the built N-API addon.
 */
import { describe, expect, it } from 'vitest';

import { sessions } from '../node.js';
import { LANE_LEFT, LANE_RIGHT, scenario, syntheticGraph, vehicle } from './fixture.js';

const graph = syntheticGraph();
const runtime = sessions();

function twoCarScenario() {
  return scenario({
    metricSubject: 'ego',
    actors: [
      vehicle(graph, { id: 'ego', rsl: LANE_LEFT, s: 20, speedMps: 10, cruiseSpeedMps: 10 }),
      vehicle(graph, { id: 'other', rsl: LANE_RIGHT, s: 40, speedMps: 8, cruiseSpeedMps: 8 }),
    ],
  });
}

describe('EnvSession', () => {
  it('excludes warm-up from policy-visible time and truncates exactly at the clip end', () => {
    const env = runtime.env({ input: twoCarScenario(), graph, episode: { decisionHz: 10 } });
    const first = env.reset('seed-a');
    expect(first.info.tS).toBe(0);
    expect(first.observation.stateVector![0]).toBeGreaterThan(20);

    let steps = 0;
    let result = env.step({});
    for (;;) {
      steps += 1;
      if (result.truncated || result.terminated) break;
      expect(steps).toBeLessThan(100);
      result = env.step({});
    }
    expect(result.truncated).toBe(true);
    expect(steps).toBe(40);
  });

  it('holds a deceleration setpoint across the decision interval and reports it in the reward terms', () => {
    const env = runtime.env({ input: twoCarScenario(), graph, episode: { decisionHz: 10 } });
    const v0 = env.reset().observation.stateVector![4]!;
    const second = env.step({ targetAccelerationMps2: -3 });
    expect(second.info.tS).toBeCloseTo(0.1, 6);
    expect(second.observation.stateVector![4]!).toBeLessThan(v0);
    expect(second.info.rewardTerms.comfort).toBeLessThanOrEqual(0);
  });

  it('replays byte-identically from a checkpoint and exposes the causal channel', () => {
    const env = runtime.env({ input: twoCarScenario(), graph, episode: { decisionHz: 10 } });
    env.reset('ckpt');
    env.step({ targetSpeedMps: 6 });
    const checkpoint = env.checkpoint();
    const a = env.step({ targetSpeedMps: 12 });
    env.restore(checkpoint);
    const b = env.step({ targetSpeedMps: 12 });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(env.causalChannel().frames.length).toBe(3);
  });
});

describe('SessionBatch', () => {
  it('matches single-session stepping world for world', () => {
    const input = twoCarScenario();
    const batch = runtime.batch({ inputs: [input, input], graphs: [graph, graph], episode: { decisionHz: 10 } });
    const single = runtime.env({ input, graph, episode: { decisionHz: 10 } });
    batch.resetAll(['s0', 's1']);
    single.reset('s1');
    const stepped = batch.stepBatch([{ targetSpeedMps: 4 }, { targetSpeedMps: 9 }]);
    const reference = single.step({ targetSpeedMps: 9 });
    const width = stepped.stateVector.length / 2;
    expect(Array.from(stepped.stateVector.subarray(width))).toEqual(Array.from(reference.observation.stateVector!));
    expect(stepped.reward[1]).toBe(reference.reward);
  });
});

describe('WorldSession', () => {
  it('logs commands, replays to the same digest and streams framed truth', () => {
    const input = twoCarScenario();
    const world = runtime.world({ input, graph, horizonSeconds: 5 });
    const truth = world.subscribeTruth({ capacity: 16 });
    const spawn = world.applyCommand('c1', 1, { kind: 'spawn', spawn: { kind: 'car', pose: { x: 300, z: 0 } } });
    expect(spawn.ok).toBe(true);
    world.advance(10);
    world.applyCommand('c1', 2, { kind: 'despawn', actorId: 'does-not-exist' });
    world.advance(5);

    const frames = truth.frames();
    expect(frames.length).toBe(15);
    expect(frames[0]!.actors.map((a) => a.id)).toContain(spawn.actorIds![0]);

    const log = world.exportLog();
    expect(log.entries.filter((e) => e.kind === 'command' && !e.ok)).toHaveLength(1);
    const replay = runtime.replayWorldLog(log, { input, graph });
    expect(replay.outcomesMatch).toBe(true);
    expect(replay.digest).toBe(log.digest);
  });
});
