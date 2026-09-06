import { describe, expect, it } from 'vitest';

import { FIXED_SCHEDULE_V1_SCHEMA, scheduleFrameMicros, unionFrameMicros, type FixedSchedule } from './schedule.js';

function schedule(sourceId: string, framesPerSecond: number, startSeconds: number, endSeconds: number): FixedSchedule {
  return {
    schema: FIXED_SCHEDULE_V1_SCHEMA, sourceId, startSeconds, endSeconds, framesPerSecond,
    frameCount: Math.round((endSeconds - startSeconds) * framesPerSecond),
  };
}

describe('fixed schedule frame timeline', () => {
  it('unions mixed-rate sources on shared microsecond timestamps', () => {
    const slow = schedule('slow', 10, 0, 1);
    const fast = schedule('fast', 15, 0, 1);
    const union = unionFrameMicros([slow, fast]);
    // Every 100 ms and every 66.67 ms coincide at 0, 200, 400, 600 and 800 ms.
    expect(union).toHaveLength(10 + 15 - 5);
    expect(union).toEqual([...union].sort((left, right) => left - right));
    for (const source of [slow, fast]) {
      for (const micros of scheduleFrameMicros(source)) expect(union).toContain(micros);
    }
  });

  it('keeps a source on its own timeline rather than the union', () => {
    const half = schedule('half', 12, 0.5, 2);
    expect(scheduleFrameMicros(half)).toHaveLength(18);
    expect(scheduleFrameMicros(half)[0]).toBe(500_000);
    expect(unionFrameMicros([half, schedule('full', 24, 0.5, 2)])).toHaveLength(36);
  });
});
