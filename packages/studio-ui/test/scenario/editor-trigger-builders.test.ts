import { describe, expect, it } from "vitest";
import { ConditionSchema, TriggerSchema } from "@simforge-oss/scenario";
import {
  buildDefaultScenarioCondition,
  buildDefaultScenarioTrigger,
} from "../../src/scenario/editor/ScenarioTimelineDock";

describe("SimForge editor trigger builders", () => {
  it.each(["at", "after", "when", "arrival"] as const)("builds schema-valid %s triggers", (kind) => {
    const trigger = buildDefaultScenarioTrigger(kind, "ego", "challenger", [{
      id: "prior", actor: "ego", trigger: { kind: "at", t: 0 }, verb: "exist", target: { state: "present" },
    }]);
    expect(TriggerSchema.safeParse(trigger).success).toBe(true);
  });

  it.each(["distance", "ttc", "headway", "reaches", "speed", "signal", "visible", "standstill", "collision", "and", "or", "not"] as const)("builds schema-valid %s conditions", (kind) => {
    expect(ConditionSchema.safeParse(buildDefaultScenarioCondition(kind, "ego", "challenger")).success).toBe(true);
  });
});
