import { describe, expect, it } from "vitest";

import { tickStepSeconds, timelineTicks } from "../../../src/lib/scenario/timeline/ticks";

const times = (window: { startMs: number; endMs: number }, maxTicks?: number) =>
  timelineTicks(window, maxTicks).map((mark) => mark.timeMs / 1000);

describe("tickStepSeconds", () => {
  it("picks a human-readable step from the ladder", () => {
    expect(tickStepSeconds(25)).toBe(2.5);
    expect(tickStepSeconds(3)).toBe(0.5);
    // 120 / 10 = exactly 12, the budget, so 10 wins and 15 is never reached.
    expect(tickStepSeconds(120)).toBe(10);
    expect(tickStepSeconds(121)).toBe(15);
  });

  it("keeps the tick count within the budget", () => {
    for (const span of [1, 3, 7, 20, 25, 60, 120]) {
      expect(span / tickStepSeconds(span)).toBeLessThanOrEqual(12);
    }
  });

  it("degrades rather than throwing on a nonsense span", () => {
    // A dock that throws takes the editor down; an unreadable rail is merely unreadable.
    expect(tickStepSeconds(0)).toBe(120);
    expect(tickStepSeconds(-5)).toBe(120);
    expect(tickStepSeconds(Number.NaN)).toBe(120);
    expect(tickStepSeconds(10_000_000)).toBe(120);
  });
});

describe("timelineTicks", () => {
  it("always labels the recorded origin, even when the step would skip it", () => {
    // `[-5, 20]` stepped by 3 lands on -3, 0... but a step that does not divide 5 evenly would miss 0
    // entirely, and 0 is the warm-up boundary — the one instant the author must be able to find.
    const ticks = times({ startMs: -5000, endMs: 20000 });
    expect(ticks).toContain(0);
  });

  it("covers the negative side of a warm-up window", () => {
    const ticks = times({ startMs: -5000, endMs: 20000 });
    expect(ticks.some((t) => t < 0)).toBe(true);
    expect(Math.min(...ticks)).toBeGreaterThanOrEqual(-5);
    expect(Math.max(...ticks)).toBeLessThanOrEqual(20);
  });

  it("emits sorted, unique, in-window times", () => {
    const ticks = times({ startMs: -5000, endMs: 20000 });
    expect([...ticks].sort((a, b) => a - b)).toEqual(ticks);
    expect(new Set(ticks).size).toBe(ticks.length);
  });

  it("does not emit -0 as a second tick at the origin", () => {
    // `(-0).toFixed(1)` is "-0.0", so an unnormalised -0 becomes a duplicate tick with a label that
    // reads as a warm-up time sitting exactly on top of the origin.
    const ticks = timelineTicks({ startMs: -5000, endMs: 20000 });
    const atOrigin = ticks.filter((mark) => mark.timeMs === 0);
    expect(atOrigin).toHaveLength(1);
    expect(atOrigin[0]?.title).toBe("0.0s");
  });

  it("has stable ids for the same window", () => {
    const a = timelineTicks({ startMs: -5000, endMs: 20000 }).map((m) => m.id);
    const b = timelineTicks({ startMs: -5000, endMs: 20000 }).map((m) => m.id);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(a.length);
  });

  it("omits the origin when the window excludes it", () => {
    const ticks = times({ startMs: 5000, endMs: 20000 });
    expect(ticks).not.toContain(0);
    expect(Math.min(...ticks)).toBeGreaterThanOrEqual(5);
  });

  it("is empty for a degenerate or inverted window", () => {
    expect(times({ startMs: 10, endMs: 10 })).toEqual([]);
    expect(times({ startMs: 100, endMs: 0 })).toEqual([]);
    expect(times({ startMs: Number.NaN, endMs: 100 })).toEqual([]);
  });

  it("handles a clip with no warm-up at all", () => {
    const ticks = times({ startMs: 0, endMs: 20000 });
    expect(ticks[0]).toBe(0);
    expect(ticks.every((t) => t >= 0)).toBe(true);
  });
});
