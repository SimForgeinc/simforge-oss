import { describe, expect, it } from 'vitest';
import type { SimTrace } from '@simforge-oss/engine';

import {
  buildSimulationDualPlayback,
  describeSimulationMotionDiff,
  diffSimulationTraces,
} from '../index.js';

const DT = 0.02;

/** A canonical trace of straight-line actors; `shift(id, t)` displaces one actor laterally. */
function trace(options: {
  clipSeconds?: number;
  actors?: readonly string[];
  shift?: (id: string, t: number) => number;
  presentFrom?: Record<string, number>;
  events?: SimTrace['events'];
  collisions?: SimTrace['metrics']['collisions'];
} = {}): SimTrace {
  const clip = options.clipSeconds ?? 20;
  const t = Array.from({ length: Math.round(clip / DT) + 1 }, (_, i) => Number((i * DT).toFixed(6)));
  const ids = [...(options.actors ?? ['ego', 'npc'])];
  const actors = Object.fromEntries(ids.map((id, index) => [id, {
    x: t.map((time) => time * 10),
    y: t.map((time) => index * 3.5 + (options.shift?.(id, time) ?? 0)),
    headingRad: t.map(() => 0),
    speedMps: t.map(() => 10),
    lateralOffsetM: t.map(() => 0),
    laneRsl: t.map(() => null),
    s: t.map((time) => time * 10),
    present: t.map((time) => (time >= (options.presentFrom?.[id] ?? 0) ? 1 : 0)),
  }]));
  return {
    header: {
      traceVersion: 4, engineVersion: 'test', inputHash: 'h', seed: 1, mapId: 'm', engineGraphDigest: 'g',
      dt: DT, clipSeconds: clip, warmupSeconds: 0, frame: 'xodr-local', actorIds: ids,
    },
    ticks: { t, actors },
    events: options.events ?? [],
    metrics: { collisions: options.collisions ?? [], minDistance: [] },
  } as unknown as SimTrace;
}

describe('diffSimulationTraces', () => {
  it('reports identical motion for identical traces, with a passing strict verdict', () => {
    const diff = diffSimulationTraces(trace(), trace());
    expect(diff.identical).toBe(true);
    expect(diff.maxPositionErrorM).toBe(0);
    expect(diff.worst).toBeNull();
    expect(diff.strict.verdict).toBe('pass');
    expect(describeSimulationMotionDiff(diff)).toBe('Motion identical');
  });

  it('treats sub-millimetre noise as identical', () => {
    const diff = diffSimulationTraces(trace(), trace({ shift: () => 0.0004 }));
    expect(diff.identical).toBe(true);
    expect(diff.maxPositionErrorM).toBeCloseTo(0.0004, 6);
  });

  it('measures the largest error, the actors it touched and when', () => {
    const diff = diffSimulationTraces(trace(), trace({ shift: (id, t) => (id === 'npc' && t >= 10 ? 1.2 : 0) }));
    expect(diff.identical).toBe(false);
    expect(diff.maxPositionErrorM).toBeCloseTo(1.2, 6);
    expect(diff.actors.changed).toEqual(['npc']);
    expect(diff.worst).toMatchObject({ actorId: 'npc' });
    expect(diff.worst!.tS).toBeCloseTo(10, 6);
    expect(diff.strict.verdict).toBe('fail');
    expect(describeSimulationMotionDiff(diff)).toBe('max 1.2 m · 1 actor changed');
  });

  it('compares the whole clip, not just the first 20 s', () => {
    const diff = diffSimulationTraces(
      trace({ clipSeconds: 30 }),
      trace({ clipSeconds: 30, shift: (id, t) => (id === 'ego' && t > 25 ? 0.5 : 0) }),
    );
    expect(diff.identical).toBe(false);
    expect(diff.maxPositionErrorM).toBeCloseTo(0.5, 6);
    expect(diff.strict.verdict).toBe('not-run');
    expect(diff.strict.reason).toMatch(/per-tick comparison covers them in full/);
  });

  it('counts added and removed actors, presence changes and event changes', () => {
    const base = trace({ actors: ['ego', 'npc'] });
    const candidate = trace({
      actors: ['ego', 'ped'],
      presentFrom: { ego: 1 },
      events: [{ t: 2, kind: 'trigger_fired', interactionId: 'i1', actorId: 'ego', verb: 'go', forced: false }],
    });
    const diff = diffSimulationTraces(base, candidate);
    expect(diff.actors.added).toEqual(['ped']);
    expect(diff.actors.removed).toEqual(['npc']);
    expect(diff.actors.changed).toEqual(['ego']);
    expect(diff.eventsChanged).toBe(1);
    expect(describeSimulationMotionDiff(diff)).toBe('3 actors · 1 event changed');
  });

  it('refuses traces on different clocks instead of misaligning them', () => {
    const other = trace();
    const slow = { ...other, header: { ...other.header, dt: 0.05 } } as SimTrace;
    expect(() => diffSimulationTraces(trace(), slow)).toThrow(/different clocks/);
  });
});

describe('buildSimulationDualPlayback', () => {
  it('pairs both poses per actor over the whole clip at the requested rate', () => {
    const playback = buildSimulationDualPlayback(trace({ clipSeconds: 30 }), trace({ clipSeconds: 30, shift: () => 2 }), 10);
    expect(playback.sampleHz).toBeCloseTo(10, 6);
    expect(playback.durationS).toBe(30);
    expect(playback.frames).toHaveLength(301);
    const last = playback.frames.at(-1)!;
    expect(last.t).toBeCloseTo(30, 6);
    expect(last.actors.ego!.positionErrorM).toBeCloseTo(2, 6);
  });
});
