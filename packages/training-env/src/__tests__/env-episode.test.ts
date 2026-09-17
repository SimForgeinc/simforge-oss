/**
 * Episode-boundary contracts of `EnvSession` beyond the reset/step semantics
 * covered in `sessions.test.ts`: the `maxDecisions` horizon, collision and goal
 * termination with their one-shot reward terms, the post-episode step refusal,
 * decision-rate validation, and seeded determinism. Requires the built N-API addon.
 */
import { describe, expect, it } from 'vitest';

import type { EnvAction, StepResult } from '../types.js';
import type { EnvSession } from '../session.js';
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

/** Ego under control passthrough closing on a stopped blocker in its own lane. */
function crashScenario() {
  return scenario({
    metricSubject: 'ego',
    clipSeconds: 6,
    warmupSeconds: 0,
    actors: [
      vehicle(graph, { id: 'ego', rsl: LANE_LEFT, s: 30, speedMps: 8, cruiseSpeedMps: 14 }),
      vehicle(graph, { id: 'blocker', rsl: LANE_LEFT, s: 45, speedMps: 0, cruiseSpeedMps: 0 }),
    ],
  });
}

/** One ego with a single interaction that fires 2 s into policy-visible time. */
function goalScenario() {
  return scenario({
    metricSubject: 'ego',
    clipSeconds: 5,
    warmupSeconds: 1,
    actors: [vehicle(graph, { id: 'ego', rsl: LANE_LEFT, s: 20, speedMps: 10, cruiseSpeedMps: 10 })],
    interactions: [
      {
        id: 'goal-at-3s',
        actorId: 'ego',
        trigger: { kind: 'at', t: 3 },
        verb: 'speed',
        target: { mode: 'stop' },
        dynamics: { shape: 'linear', constraint: 'rate', value: 3 },
      },
    ],
  });
}

/** Run to the first `terminated`/`truncated` decision, bounded by `guard` steps. */
function runToEnd(env: EnvSession, action: EnvAction, guard: number): { result: StepResult; steps: number } {
  let result = env.step(action);
  let steps = 1;
  while (!result.terminated && !result.truncated) {
    expect(steps).toBeLessThan(guard);
    result = env.step(action);
    steps += 1;
  }
  return { result, steps };
}

describe('EnvSession episode boundaries', () => {
  it('honours maxDecisions as a truncation horizon', () => {
    const env = runtime.env({ input: twoCarScenario(), graph, episode: { decisionHz: 10, maxDecisions: 7 } });
    env.reset('horizon');
    const { result, steps } = runToEnd(env, {}, 50);
    expect(result.truncated).toBe(true);
    expect(result.terminated).toBe(false);
    expect(steps).toBe(7);
  });

  it('terminates on a forced collision with the collision penalty dominating the reward', () => {
    const env = runtime.env({ input: crashScenario(), graph, episode: { decisionHz: 25 } });
    env.reset('crash');
    const { result } = runToEnd(env, { control: { throttle: 1, brake: 0, steer: 0 } }, 300);
    expect(result.terminated).toBe(true);
    expect(result.reward).toBeLessThan(-9);
    expect(result.info.events.some((e) => e.kind === 'collision' && (e.a === 'ego' || e.b === 'ego'))).toBe(true);
  });

  it('terminates with the goal bonus when the goal trigger fires', () => {
    const env = runtime.env({
      input: goalScenario(),
      graph,
      episode: { decisionHz: 10, goal: { interactionId: 'goal-at-3s' } },
    });
    env.reset('goal');
    const { result } = runToEnd(env, {}, 100);
    expect(result.terminated).toBe(true);
    expect(result.reward).toBeGreaterThan(9);
  });

  it('refuses to step once the episode has finished', () => {
    const env = runtime.env({ input: twoCarScenario(), graph, episode: { decisionHz: 10, maxDecisions: 2 } });
    env.reset('over');
    env.step();
    env.step();
    expect(() => env.step()).toThrow(/finished/);
  });

  it('is deterministic: the same seed and action sequence reproduce every decision', () => {
    const ACTIONS: readonly EnvAction[] = [
      { targetSpeedMps: 12 },
      {},
      { targetAccelerationMps2: -1 },
      { targetSpeedMps: 8 },
      {},
      {},
      { targetSpeedMps: 11 },
      {},
    ];
    const run = (): string[] => {
      const env = runtime.env({ input: twoCarScenario(), graph, episode: { decisionHz: 10 } });
      env.reset('determinism-seed');
      return ACTIONS.map((action) => {
        const result = env.step(action);
        return JSON.stringify([
          [...result.observation.stateVector!],
          result.observation.objects.map((o) => [o.id, o.rangeM, o.bearingRad, o.rangeRateMps]),
          result.reward,
          result.info.causal,
        ]);
      });
    };
    expect(run()).toEqual(run());
  });

  it('rejects a decision rate that does not divide the engine tick', () => {
    expect(() => runtime.env({ input: twoCarScenario(), graph, episode: { decisionHz: 30 } })).toThrow(/decisionHz/);
  });
});
