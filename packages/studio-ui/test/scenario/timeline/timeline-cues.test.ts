import { describe, expect, it } from "vitest";
import type { Interaction, ScenarioTemplateV2 } from "@simforge-oss/scenario";

import {
  buildTimelineCues,
  timelineConflictMessage,
} from "../../../src/scenario/editor/timeline/timeline-cues";

function template(interactions: readonly Interaction[]): ScenarioTemplateV2 {
  return {
    scenarioVersion: 2,
    meta: {
      name: "timeline cues",
      createdAt: "2026-08-09T00:00:00.000Z",
      modifiedAt: "2026-08-09T00:00:00.000Z",
      appVersion: "test",
    },
    params: { declarations: [] },
    anchor: { features: [] },
    roles: [],
    choreography: { warmupSeconds: 0, clipSeconds: 20, interactions: [...interactions] },
    reasoningTrace: [],
    invariants: [],
    variants: [],
  } as unknown as ScenarioTemplateV2;
}

function speed(
  id: string,
  trigger: Interaction["trigger"],
  until?: Interaction["until"],
): Interaction {
  return {
    id,
    actor: "ego",
    trigger,
    ...(until ? { until } : {}),
    verb: "speed",
    target: { mode: "absolute", valueKph: 40 },
    dynamics: { shape: "linear", constraint: "time", value: 1 },
  };
}

describe("timeline presentation cues", () => {
  it("distinguishes set-time actions from event actions and keeps authored deadlines", () => {
    const cues = buildTimelineCues(template([
      speed("clock", { kind: "at", t: 2 }, { kind: "at", t: 3 }),
      speed("event", {
        kind: "when",
        condition: { kind: "speed", of: "ego", op: ">=", valueKph: 30 },
        byLatest: 8,
        ifNever: "skip",
      }),
    ]));

    expect(cues.get("clock")).toMatchObject({ cause: "time", deadlineS: null });
    expect(cues.get("event")).toMatchObject({ cause: "event", deadlineS: 8 });
  });

  it("marks both actions when one actor has overlapping speed control", () => {
    const cues = buildTimelineCues(template([
      speed("first", { kind: "at", t: 1 }, { kind: "at", t: 4 }),
      speed("second", { kind: "at", t: 2 }, { kind: "at", t: 5 }),
    ]));

    expect(cues.get("first")?.conflict).toBe("conflict");
    expect(cues.get("second")?.conflict).toBe("conflict");
    expect(timelineConflictMessage(cues.get("first")!)).toBe(
      "Another action controls speed at the same time",
    );
  });

  it("uses a softer warning when two event windows might overlap", () => {
    const eventTrigger = (byLatest: number) => ({
      kind: "when" as const,
      condition: { kind: "speed" as const, of: "ego", op: ">=" as const, valueKph: 30 },
      byLatest,
      ifNever: "skip" as const,
    });
    const cues = buildTimelineCues(template([
      speed("first", eventTrigger(6)),
      speed("second", eventTrigger(8)),
    ]));

    expect(cues.get("first")?.conflict).toBe("possible");
    expect(cues.get("second")?.conflict).toBe("possible");
  });
});
