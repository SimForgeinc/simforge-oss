import { describe, expect, it, vi } from "vitest";
import {
  clampRange,
  rangeContains,
  rangesOverlap,
  timelinePercent,
} from "../../../src/lib/scenario/timeline/geometry";
import {
  createTimelineLaneRegistry,
  type TimelineLaneSource,
} from "../../../src/lib/scenario/timeline/lane-registry";

function lane(overrides: Partial<TimelineLaneSource> = {}): TimelineLaneSource {
  return {
    laneId: "lane_a",
    kind: "actor",
    label: "Actor A",
    order: 0,
    spans: () => [],
    ...overrides,
  };
}

describe("timelinePercent", () => {
  it("maps a time onto a percentage of the rail", () => {
    expect(timelinePercent(500, 1000)).toBe(50);
  });

  it("clamps past the end rather than overflowing the rail", () => {
    expect(timelinePercent(2000, 1000)).toBe(100);
  });

  it("returns 0 for a zero duration instead of Infinity", () => {
    // A NaN or Infinity here becomes `left: NaN%`, which drops the element from the layout
    // silently — worse than rendering it at the origin.
    expect(timelinePercent(500, 0)).toBe(0);
    expect(Number.isFinite(timelinePercent(500, 0))).toBe(true);
  });

  it("returns 0 rather than NaN for non-finite input", () => {
    expect(timelinePercent(Number.NaN, 1000)).toBe(0);
    expect(timelinePercent(500, Number.NaN)).toBe(0);
  });

  it("never returns a negative percentage for a negative time", () => {
    expect(timelinePercent(-500, 1000)).toBe(0);
  });
});

describe("range predicates", () => {
  it("treats a range as start-inclusive and end-exclusive", () => {
    const range = { startMs: 100, endMs: 200 };
    expect(rangeContains(range, 100)).toBe(true);
    expect(rangeContains(range, 199)).toBe(true);
    expect(rangeContains(range, 200)).toBe(false);
  });

  it("does NOT count touching ranges as overlapping", () => {
    // This is what makes back-to-back clips legal. If touching counted as overlap, a lane would
    // reject every clip laid down immediately after another.
    expect(rangesOverlap({ startMs: 0, endMs: 100 }, { startMs: 100, endMs: 200 })).toBe(false);
  });

  it("detects a real overlap in both directions", () => {
    const a = { startMs: 0, endMs: 150 };
    const b = { startMs: 100, endMs: 200 };
    expect(rangesOverlap(a, b)).toBe(true);
    expect(rangesOverlap(b, a)).toBe(true);
  });

  it("treats a zero-length range as overlapping nothing", () => {
    expect(rangesOverlap({ startMs: 100, endMs: 100 }, { startMs: 0, endMs: 200 })).toBe(false);
  });
});

describe("clampRange", () => {
  it("preserves duration when shifting a range inside the bounds", () => {
    expect(clampRange({ startMs: 900, endMs: 1100 }, { startMs: 0, endMs: 1000 })).toEqual({
      startMs: 800,
      endMs: 1000,
    });
  });

  it("collapses to the bounds when the range is longer than they are", () => {
    expect(clampRange({ startMs: 0, endMs: 5000 }, { startMs: 0, endMs: 1000 })).toEqual({
      startMs: 0,
      endMs: 1000,
    });
  });

  it("shifts a range that starts before the bounds", () => {
    expect(clampRange({ startMs: -50, endMs: 50 }, { startMs: 0, endMs: 1000 })).toEqual({
      startMs: 0,
      endMs: 100,
    });
  });
});

describe("lane registry — the seam with the signals lane", () => {
  it("orders lanes by order, breaking ties on laneId for a stable render", () => {
    const registry = createTimelineLaneRegistry();
    registry.register(lane({ laneId: "b", order: 1 }));
    registry.register(lane({ laneId: "a", order: 1 }));
    registry.register(lane({ laneId: "c", order: 0 }));
    expect(registry.lanes().map((entry) => entry.laneId)).toEqual(["c", "a", "b"]);
  });

  it("rejects a duplicate lane id rather than hiding one lane behind another", () => {
    const registry = createTimelineLaneRegistry();
    registry.register(lane({ laneId: "dup" }));
    expect(() => registry.register(lane({ laneId: "dup" }))).toThrow(/already registered/);
  });

  it("disposes idempotently, so a double unmount cannot remove a re-registered lane", () => {
    const registry = createTimelineLaneRegistry();
    const dispose = registry.register(lane({ laneId: "x" }));
    dispose();
    dispose();
    registry.register(lane({ laneId: "x", label: "Re-added" }));
    dispose();
    expect(registry.lanes().map((entry) => entry.label)).toEqual(["Re-added"]);
  });

  it("notifies subscribers on register and dispose", () => {
    const registry = createTimelineLaneRegistry();
    const listener = vi.fn();
    const unsubscribe = registry.subscribe(listener);
    const dispose = registry.register(lane());
    expect(listener).toHaveBeenCalledTimes(1);
    dispose();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    registry.register(lane({ laneId: "after" }));
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("carries an opaque datum, so a signal lane needs no type from the timeline", () => {
    type SignalPhase = { phase: "green" | "amber" | "red"; junctionId: string };
    const registry = createTimelineLaneRegistry();
    registry.register({
      laneId: "signal_j1",
      kind: "signal",
      label: "Junction 1",
      order: 5,
      spans: () => [
        { id: "s1", startMs: 0, endMs: 1000, datum: { phase: "green", junctionId: "j1" } },
      ],
    } satisfies TimelineLaneSource<SignalPhase>);

    const [registered] = registry.lanes();
    if (!registered) throw new Error("expected a registered lane");
    const [span] = registered.spans({ startMs: 0, endMs: 2000 });
    if (!span) throw new Error("expected a span");
    expect((span.datum as SignalPhase).phase).toBe("green");
  });

  it("pulls spans per window, so lanes own their own sampling", () => {
    const spans = vi.fn(() => []);
    const registry = createTimelineLaneRegistry();
    registry.register(lane({ spans }));
    const [registered] = registry.lanes();
    if (!registered) throw new Error("expected a registered lane");
    registered.spans({ startMs: 0, endMs: 500 });
    registered.spans({ startMs: 500, endMs: 1000 });
    expect(spans).toHaveBeenNthCalledWith(1, { startMs: 0, endMs: 500 });
    expect(spans).toHaveBeenNthCalledWith(2, { startMs: 500, endMs: 1000 });
  });
});
