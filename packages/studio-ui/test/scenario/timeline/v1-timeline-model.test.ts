import type { Interaction } from "@simforge-oss/scenario";
import { describe, expect, it } from "vitest";

import {
  authoredTimelineRange,
  authoredTimelineRangesEqual,
  editAuthoredTimelineRange,
  interactionWithAuthoredTimelineRange,
  packTimelineInteractionRows,
  uniqueTimelineInteractionId,
} from "../../../src/scenario/editor/timeline/v1-timeline-model";

describe("timeline interaction model", () => {
  it("edits only literal authored edges and preserves every non-timing field", () => {
    const exact = {
      id: "speed",
      actor: "ego",
      trigger: { kind: "at", t: 1 },
      until: { kind: "at", t: 2 },
      verb: "speed",
      target: { mode: "delta", deltaKph: 10 },
      dynamics: { shape: "linear", constraint: "time", value: 1 },
    } as Interaction;
    const conditional = {
      ...exact,
      trigger: {
        kind: "when",
        condition: { kind: "speed", of: "ego", op: ">=", valueKph: 20 },
        byLatest: 5,
        ifNever: "skip",
      },
    } as Interaction;

    expect(authoredTimelineRange(exact)).toEqual({ startS: 1, endS: 2 });
    expect(authoredTimelineRange(conditional)).toBeNull();
    expect(authoredTimelineRange({ ...exact, until: undefined } as Interaction)).toBeNull();

    const moved = editAuthoredTimelineRange(
      { startS: 1, endS: 2 },
      "move",
      2.24,
      { startMs: 0, endMs: 20000 },
    );
    expect(moved).toEqual({ startS: 3.2, endS: 4.2 });
    expect(interactionWithAuthoredTimelineRange(exact, moved)).toEqual({
      ...exact,
      trigger: { kind: "at", t: 3.2 },
      until: { kind: "at", t: 4.2 },
    });
  });

  it("keeps resize and move gestures inside the recorded authoring window", () => {
    const window = { startMs: 0, endMs: 10000 };
    expect(editAuthoredTimelineRange({ startS: 1, endS: 4 }, "move", -99, window)).toEqual({
      startS: 0,
      endS: 3,
    });
    expect(editAuthoredTimelineRange({ startS: 8, endS: 10 }, "move", 99, window)).toEqual({
      startS: 8,
      endS: 10,
    });
    expect(editAuthoredTimelineRange({ startS: 2, endS: 3 }, "resize-start", 99, window)).toEqual({
      startS: 2.9,
      endS: 3,
    });
  });

  it("allocates collision-free conventional ids and preserves the changing suffix", () => {
    expect(uniqueTimelineInteractionId("accelerate_ego", ["first", "accelerate_ego_3"])).toBe(
      "accelerate_ego_4",
    );
    const longStem = "interaction".repeat(10);
    const first = uniqueTimelineInteractionId(longStem, []);
    const second = uniqueTimelineInteractionId(longStem, [first]);
    expect(first).not.toBe(second);
    expect(first.length).toBeLessThanOrEqual(64);
    expect(second.length).toBeLessThanOrEqual(64);
  });

  it("recognizes a snapped no-op range", () => {
    expect(
      authoredTimelineRangesEqual(
        { startS: 1, endS: 2 },
        editAuthoredTimelineRange(
          { startS: 1, endS: 2 },
          "move",
          0,
          { startMs: 0, endMs: 10000 },
        ),
      ),
    ).toBe(true);
  });

  it("uses one row for sequential actions and expands only for overlapping actions", () => {
    const item = (id: string, startMs: number, endMs: number) => ({
      interaction: { id },
      range: { startMs, endMs },
    });
    const rows = packTimelineInteractionRows([
      item("accelerate", 1_000, 3_000),
      item("signal", 3_000, 4_000),
      item("brake", 2_000, 5_000),
      item("resume", 5_000, 6_000),
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0]!.map((entry) => entry.interaction.id)).toEqual(["accelerate", "signal", "resume"]);
    expect(rows[1]!.map((entry) => entry.interaction.id)).toEqual(["brake"]);
  });
});
