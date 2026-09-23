/**
 * Protocol-level properties of the engine's interaction lifecycle, the part of
 * SimForge that plays the role of the OpenSCENARIO storyboard state machine
 * (docs/engineering/openscenario-conformance.md, "Protocol tests").
 *
 * The runtime is small and hand-written (`engine/triggers.rs`,
 * `engine/interactions.rs`): every interaction is Pending → Fired | Skipped,
 * and preemption is per control axis. These tests pin the invariants the XML
 * export relies on (one execution per event, level-triggered `when`, `after`
 * as startTransition/completeState + delay, per-axis override, nothing before
 * clip time 0) over many seeded random storyboards plus targeted cases.
 *
 * Requires the built addon (`pnpm --filter @simforge-oss/native-runtime build:node`).
 */

import { describe, expect, it } from 'vitest';

import { runSimulation } from '../node.js';
import type { SimScenarioInputSpec } from '../schema/input.js';
import type { SimEvent, SimTrace } from '../trace/trace.js';
import { LANE_LEFT, LANE_RIGHT, scenario, syntheticGraph, vehicle } from './fixtures/scenarios.js';

const graph = syntheticGraph();
const DT = 0.02;

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

type Interaction = NonNullable<SimScenarioInputSpec['interactions']>[number];

const byInteraction = (trace: SimTrace, kind: SimEvent['kind'], id: string) =>
  trace.events.filter((event) => event.kind === kind && 'interactionId' in event && event.interactionId === id);

/** A random, cycle-free storyboard over two cars on adjacent lanes. */
function randomStoryboard(seed: number) {
  const random = rng(seed);
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const round = (value: number) => Math.round(value * 100) / 100;
  const actors = [
    vehicle(graph, { id: 'a', rsl: LANE_LEFT, s: 40, speedMps: 8 + random() * 8, cruiseSpeedMps: undefined }),
    vehicle(graph, { id: 'b', rsl: LANE_RIGHT, s: 60 + random() * 60, speedMps: 5 + random() * 8 }),
  ];
  const interactions: Interaction[] = [];
  const count = 3 + Math.floor(random() * 5);
  for (let index = 0; index < count; index += 1) {
    const actorId = pick(['a', 'b']);
    const id = `i${index}`;
    const verbRoll = random();
    const verb = verbRoll < 0.55
      ? { verb: 'speed' as const, target: { mode: 'absolute' as const, value: round(2 + random() * 16) }, dynamics: { shape: pick(['linear', 'cubic', 'sinusoidal', 'step'] as const), constraint: pick(['time', 'rate'] as const), value: round(0.5 + random() * 3) } }
      : verbRoll < 0.8
        ? { verb: 'changeLane' as const, target: { mode: actorId === 'a' ? 'right' as const : 'left' as const, count: 1 }, dynamics: { shape: 'sinusoidal' as const, constraint: 'time' as const, value: round(2 + random() * 3) } }
        : { verb: 'set' as const, target: { key: 'lights.brake', value: random() < 0.5 } };
    const triggerRoll = random();
    const earlier = interactions.length ? pick(interactions).id : null;
    const other = actorId === 'a' ? 'b' : 'a';
    const trigger = triggerRoll < 0.35 || !earlier
      ? { kind: 'at' as const, t: round(random() * 8) }
      : triggerRoll < 0.6
        ? { kind: 'after' as const, interactionId: earlier, event: pick(['start', 'end'] as const), delayS: round(random() * 2) }
        : {
            kind: 'when' as const,
            condition: pick([
              { kind: 'speed' as const, actorId, cmp: pick(['gt', 'lt'] as const), value: round(4 + random() * 12) },
              { kind: 'distance' as const, a: actorId, b: other, mode: 'euclidean' as const, cmp: pick(['lt', 'gt'] as const), value: round(5 + random() * 60) },
              { kind: 'standstill' as const, actorId, durationS: round(random()) },
            ]),
            byLatest: round(2 + random() * 15),
            ifNever: pick(['fire', 'skip'] as const),
          };
    interactions.push({ id, actorId, trigger, ...verb } as Interaction);
  }
  return scenario({ clipSeconds: 12, warmupSeconds: 1, actors, interactions });
}

describe('interaction lifecycle protocol (random storyboards)', () => {
  const SEEDS = Array.from({ length: 40 }, (_, index) => 1000 + index);

  it.each(SEEDS)('seed %i: at most one start, at most one terminal end, never before start, never before t=0', (seed) => {
    const input = randomStoryboard(seed);
    const { trace } = runSimulation(input, { graph });
    for (const interaction of input.interactions) {
      const fired = byInteraction(trace, 'trigger_fired', interaction.id);
      const skipped = byInteraction(trace, 'trigger_skipped', interaction.id);
      const ended = [...byInteraction(trace, 'interaction_completed', interaction.id), ...byInteraction(trace, 'interaction_aborted', interaction.id)];
      // maximumExecutionCount = 1: an interaction never starts twice ...
      expect(fired.length, `${interaction.id} fired ${fired.length}×`).toBeLessThanOrEqual(1);
      // ... is never both started and skipped ...
      expect(fired.length + skipped.length, `${interaction.id} fired and skipped`).toBeLessThanOrEqual(1);
      // ... and never completes twice, nor completes without having started.
      expect(ended.length, `${interaction.id} ended ${ended.length}×`).toBeLessThanOrEqual(1);
      if (ended.length) {
        expect(fired.length, `${interaction.id} ended without starting`).toBe(1);
        expect(ended[0]!.t).toBeGreaterThanOrEqual(fired[0]!.t);
      }
      for (const event of [...fired, ...skipped]) expect(event.t, `${interaction.id} evaluated in the warm-up`).toBeGreaterThanOrEqual(0);
    }
  });

  it.each(SEEDS)('seed %i: `after` fires on the first tick at or after the reference start/end plus delay, and inherits a skip', (seed) => {
    const input = randomStoryboard(seed);
    const { trace } = runSimulation(input, { graph });
    for (const interaction of input.interactions) {
      if (interaction.trigger.kind !== 'after') continue;
      const trigger = interaction.trigger;
      const parentFired = byInteraction(trace, 'trigger_fired', trigger.interactionId)[0];
      const parentSkipped = byInteraction(trace, 'trigger_skipped', trigger.interactionId)[0];
      const fired = byInteraction(trace, 'trigger_fired', interaction.id)[0];
      const skipped = byInteraction(trace, 'trigger_skipped', interaction.id)[0];
      if (parentSkipped) {
        expect(fired, `${interaction.id} fired although ${trigger.interactionId} was skipped`).toBeUndefined();
        continue;
      }
      if ((trigger.event ?? 'start') !== 'start' || !parentFired) continue;
      const due = parentFired.t + (trigger.delayS ?? 0);
      if (due > input.clipSeconds - DT) continue;
      expect(fired ?? skipped, `${interaction.id} after start never resolved`).toBeDefined();
      if (fired) {
        expect(fired.t).toBeGreaterThanOrEqual(due - 1e-9);
        expect(fired.t).toBeLessThan(due + DT + 1e-9);
      }
    }
  });
});

describe('interaction lifecycle protocol (targeted)', () => {
  const car = (id: string, rsl = LANE_LEFT, s = 40, speedMps = 15) => vehicle(graph, { id, rsl, s, speedMps, cruiseSpeedMps: speedMps });
  const ramp = (id: string, t: number, value: number, seconds: number): Interaction => ({
    id, actorId: 'a', trigger: { kind: 'at', t }, verb: 'speed',
    target: { mode: 'absolute', value }, dynamics: { shape: 'linear', constraint: 'time', value: seconds },
  });

  it('a newer interaction on the same axis preempts the running one (OSC override within a domain)', () => {
    const input = scenario({ clipSeconds: 6, warmupSeconds: 0, actors: [car('a')], interactions: [ramp('slow', 1, 5, 4), ramp('fast', 2, 20, 2)] });
    const { trace } = runSimulation(input, { graph });
    const preemption = trace.events.find((event) => event.kind === 'preemption');
    expect(preemption).toMatchObject({ t: 2, actorId: 'a', axis: 'longitudinal', byInteractionId: 'fast', preemptedInteractionId: 'slow' });
  });

  it('an interaction on another axis does not preempt (OSC parallel events on different domains)', () => {
    const input = scenario({
      clipSeconds: 6, warmupSeconds: 0, actors: [car('a')],
      interactions: [
        ramp('slow', 1, 5, 4),
        { id: 'light', actorId: 'a', trigger: { kind: 'at', t: 2 }, verb: 'set', target: { key: 'lights.brake', value: true } },
      ],
    });
    const { trace } = runSimulation(input, { graph });
    expect(trace.events.filter((event) => event.kind === 'preemption')).toEqual([]);
  });

  it('`when` is level-triggered: a condition already true on the first check fires at t=0 with no prior sample', () => {
    const input = scenario({
      clipSeconds: 3, warmupSeconds: 1,
      actors: [car('a'), car('b', LANE_RIGHT, 45)],
      interactions: [{
        id: 'near', actorId: 'a', verb: 'speed', target: { mode: 'absolute', value: 10 }, dynamics: { shape: 'linear', constraint: 'time', value: 1 },
        trigger: { kind: 'when', condition: { kind: 'distance', a: 'a', b: 'b', mode: 'euclidean', cmp: 'lt', value: 30 }, byLatest: 100, ifNever: 'skip' },
      }],
    });
    const { trace } = runSimulation(input, { graph });
    // True throughout the warm-up as well, yet evaluated only from clip time 0.
    expect(byInteraction(trace, 'trigger_fired', 'near').map((event) => event.t)).toEqual([0]);
  });

  it('`when` fires at most once even when its condition drops and rises again', () => {
    const input = scenario({
      clipSeconds: 10, warmupSeconds: 0, actors: [car('a', LANE_LEFT, 40, 10)],
      interactions: [
        ramp('up', 0.5, 16, 2),
        ramp('down', 4, 8, 2),
        ramp('up-again', 7, 16, 2),
        {
          id: 'fast', actorId: 'a', verb: 'set', target: { key: 'lights.brake', value: true },
          trigger: { kind: 'when', condition: { kind: 'speed', actorId: 'a', cmp: 'gt', value: 13 }, byLatest: 100, ifNever: 'skip' },
        },
      ],
    });
    const { trace } = runSimulation(input, { graph });
    const track = trace.ticks.actors.a!;
    const above = track.speedMps.map((speed) => speed > 13);
    const risingEdges = above.filter((value, index) => index > 0 && value && !above[index - 1]).length;
    expect(risingEdges, 'fixture must cross the threshold more than once').toBeGreaterThanOrEqual(2);
    expect(byInteraction(trace, 'trigger_fired', 'fast')).toHaveLength(1);
  });

  it('`at` fires on the first 20 ms tick at or after its time', () => {
    const input = scenario({ clipSeconds: 3, warmupSeconds: 0, actors: [car('a')], interactions: [ramp('late', 1.01, 5, 1)] });
    const { trace } = runSimulation(input, { graph });
    expect(byInteraction(trace, 'trigger_fired', 'late').map((event) => event.t)).toEqual([1.02]);
  });

  it('`after` a skipped interaction is skipped too', () => {
    const input = scenario({
      clipSeconds: 4, warmupSeconds: 0, actors: [car('a'), car('far', LANE_RIGHT, 390)],
      interactions: [
        {
          id: 'never', actorId: 'a', verb: 'speed', target: { mode: 'absolute', value: 5 }, dynamics: { shape: 'linear', constraint: 'time', value: 1 },
          trigger: { kind: 'when', condition: { kind: 'distance', a: 'a', b: 'far', mode: 'euclidean', cmp: 'lt', value: 1 }, byLatest: 1, ifNever: 'skip' },
        },
        { ...ramp('chained', 0, 10, 1), trigger: { kind: 'after', interactionId: 'never', event: 'start', delayS: 0 } },
      ],
    });
    const { trace } = runSimulation(input, { graph });
    expect(byInteraction(trace, 'trigger_skipped', 'never')).toHaveLength(1);
    expect(byInteraction(trace, 'trigger_fired', 'chained')).toHaveLength(0);
    expect(byInteraction(trace, 'trigger_skipped', 'chained')).toHaveLength(1);
  });

  // Formerly pinned deviations F-02/F-03, fixed in ENGINE_SEM_VER 0.10.0.
  it('F-02: `after end` of a speed interaction fires once the target speed is reached (OSC completeState)', () => {
    const input = scenario({
      clipSeconds: 6, warmupSeconds: 0, actors: [car('a')],
      interactions: [ramp('slow', 1, 10, 1), { ...ramp('then', 0, 15, 1), trigger: { kind: 'after', interactionId: 'slow', event: 'end', delayS: 0.5 } }],
    });
    const { trace } = runSimulation(input, { graph });
    // slow: 15 -> 10 m/s linear over 1 s from t=1 completes at 2.0; then +0.5 s.
    expect(byInteraction(trace, 'interaction_completed', 'slow').map((event) => event.t)).toEqual([2]);
    expect(byInteraction(trace, 'trigger_fired', 'then').map((event) => event.t)).toEqual([2.5]);
  });

  const deadline = (window?: { startS: number; endS: number }): Interaction => ({
    ...ramp('deadline', 0, 10, 1),
    trigger: { kind: 'when', condition: { kind: 'distance', a: 'a', b: 'far', mode: 'euclidean', cmp: 'lt', value: 1 }, byLatest: 2, ifNever: 'fire' },
    ...(window ? { window } : {}),
  } as Interaction);

  it('`when … ifNever: fire` fires at `byLatest` when the condition never holds (engine input form)', () => {
    const input = scenario({ clipSeconds: 5, warmupSeconds: 0, actors: [car('a'), car('far', LANE_RIGHT, 390)], interactions: [deadline()] });
    const { trace } = runSimulation(input, { graph });
    expect(byInteraction(trace, 'trigger_fired', 'deadline').map((event) => event.t)).toEqual([2]);
  });

  // simforge-compiler no longer lowers `byLatest` into a window end (F-03); an
  // explicit window that ends at the deadline still closes eligibility first.
  it('F-03: an explicit window ending at the deadline skips instead of firing', () => {
    const input = scenario({ clipSeconds: 5, warmupSeconds: 0, actors: [car('a'), car('far', LANE_RIGHT, 390)], interactions: [deadline({ startS: 0, endS: 2 })] });
    const { trace } = runSimulation(input, { graph });
    expect(byInteraction(trace, 'trigger_fired', 'deadline')).toEqual([]);
    expect(byInteraction(trace, 'trigger_skipped', 'deadline')).toHaveLength(1);
  });

  it('a prescribed speed profile is exact, instantaneous for a step, and hands back without overshoot', () => {
    const step = { ...ramp('step', 1, 5, 1), dynamics: { shape: 'step', constraint: 'time', value: 1 } } as Interaction;
    const input = scenario({ clipSeconds: 4, warmupSeconds: 0, actors: [car('a')], interactions: [step] });
    const { trace } = runSimulation(input, { graph });
    const speed = trace.ticks.actors.a!.speedMps;
    const at = (t: number) => speed[trace.ticks.t.findIndex((value) => Math.abs(value - t) < 1e-9)]!;
    expect(at(1)).toBeCloseTo(15, 2);
    expect(at(1.02)).toBeCloseTo(5, 9);
    // After completion the cruise state holds the target: no ringing.
    for (const t of [1.5, 2, 3, 4]) expect(Math.abs(at(t) - 5)).toBeLessThan(0.02);
    expect(trace.events.some((event) => event.kind === 'prescribed_motion' && event.interactionId === 'step')).toBe(true);
  });

  it('exist(absent) shows from the tick after its trigger', () => {
    const input = scenario({
      clipSeconds: 3, warmupSeconds: 0, actors: [car('a')],
      interactions: [{ id: 'gone', actorId: 'a', trigger: { kind: 'at', t: 1 }, verb: 'exist', target: { state: 'absent' } }],
    });
    const { trace } = runSimulation(input, { graph });
    const present = trace.ticks.actors.a!.present;
    const at = (t: number) => present[trace.ticks.t.findIndex((value) => Math.abs(value - t) < 1e-9)];
    expect([at(0.98), at(1), at(1.02)]).toEqual([1, 1, 0]);
  });

  it('a newer speed command on the same axis ends the running one (stopTransition)', () => {
    const input = scenario({ clipSeconds: 6, warmupSeconds: 0, actors: [car('a')], interactions: [ramp('slow', 1, 5, 4), ramp('fast', 2, 20, 2)] });
    const { trace } = runSimulation(input, { graph });
    expect(byInteraction(trace, 'interaction_aborted', 'slow')).toEqual([
      expect.objectContaining({ t: 2, reason: 'preempted' }),
    ]);
  });
});
