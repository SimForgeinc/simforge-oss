import { describe, expect, it } from 'vitest';

import { SnapshotClock, bracketSnapshots, lerp, lerpAngle } from '../snapshot-clock';

const STEP_S = 0.02;

describe('snapshot interpolation math', () => {
  const times = [0, 0.02, 0.04, 0.06];
  const at = (t: number) => bracketSnapshots(times, (x) => x, t);

  it('brackets a time between the two steps around it', () => {
    expect(at(0.03)).toEqual({ from: 0.02, to: 0.04, alpha: expect.closeTo(0.5, 9) });
    expect(at(0.041)).toEqual({ from: 0.04, to: 0.06, alpha: expect.closeTo(0.05, 9) });
    expect(at(0.04)).toEqual({ from: 0.04, to: 0.06, alpha: 0 });
  });

  it('holds at the ends instead of extrapolating', () => {
    expect(at(-1)).toEqual({ from: 0, to: 0, alpha: 0 });
    expect(at(0.5)).toEqual({ from: 0.06, to: 0.06, alpha: 0 });
    expect(bracketSnapshots([], (x: number) => x, 0)).toBeNull();
  });

  it('blends positions linearly and headings along the shorter arc', () => {
    expect(lerp(2, 4, 0.25)).toBe(2.5);
    // 3.1 rad to -3.1 rad is 0.083 rad through ±π, not 6.2 rad back through 0.
    const mid = lerpAngle(3.1, -3.1, 0.5);
    expect(Math.abs(Math.atan2(Math.sin(mid), Math.cos(mid)))).toBeCloseTo(Math.PI, 6);
    expect(lerpAngle(0.1, 0.3, 0.5)).toBeCloseTo(0.2, 12);
  });
});

describe('snapshot clock', () => {
  it('draws the newest step until the channel has shown its cadence', () => {
    const clock = new SnapshotClock();
    expect(clock.advance(0)).toBeNull();
    clock.observe(0, 100);
    expect(clock.advance(100.001)).toBe(0);
  });

  it('never runs ahead of the newest step or backwards', () => {
    const clock = new SnapshotClock();
    let sim = 0;
    let previous = -Infinity;
    for (let frame = 0; frame < 600; frame += 1) {
      const wall = frame / 60;
      // A channel that delivers three steps every 60 ms and then goes quiet.
      if (frame % 4 === 0 && frame < 300) {
        for (let k = 0; k < 3; k += 1) clock.observe((sim += STEP_S), wall);
      }
      const drawn = clock.advance(wall)!;
      expect(drawn).toBeLessThanOrEqual(sim + 1e-12);
      expect(drawn).toBeGreaterThanOrEqual(previous);
      previous = drawn;
    }
    // Silence parks the render time on the newest step.
    expect(previous).toBeCloseTo(sim, 12);
  });

  it('resumes smoothly after a pause instead of leaping to catch up', () => {
    const clock = new SnapshotClock();
    let sim = 0;
    const drawn: number[] = [];
    for (let frame = 0; frame < 360; frame += 1) {
      const wall = frame / 60;
      // Paused from 2 s to 4 s of wall time; the sim resumes where it stopped.
      if (wall < 2 || wall >= 4) {
        const simWall = wall < 2 ? wall : wall - 2;
        while (sim + STEP_S <= simWall + 1e-9) clock.observe((sim += STEP_S), wall);
      }
      drawn.push(clock.advance(wall)!);
    }
    const steps = drawn.slice(1).map((value, index) => value - drawn[index]!);
    // Never more than two display frames' worth of sim in one frame.
    expect(Math.max(...steps)).toBeLessThan((2 / 60) * 1.1);
    expect(drawn.at(-1)!).toBeGreaterThan(3.8);
  });

  it('lags a steady 50 Hz channel by only a step or two', () => {
    const clock = new SnapshotClock();
    let sim = 0;
    for (let wall = 0; wall < 3; wall += 1 / 60) {
      while (sim + STEP_S <= wall) clock.observe((sim += STEP_S), wall);
      clock.advance(wall);
    }
    expect(clock.lagS).not.toBeNull();
    expect(clock.lagS!).toBeLessThan(2.5 * STEP_S);
  });
});
