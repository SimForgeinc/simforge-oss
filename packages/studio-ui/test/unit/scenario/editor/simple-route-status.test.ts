import { describe, expect, it } from "vitest";
import type { Interaction } from "@simforge-oss/scenario";

import { isUnconfiguredSimpleTimedRoute } from "../../../../src/scenario/editor/simple-route-status";

function route(points: Array<{ timeS: number; x: number; z: number }>): Interaction {
  return {
    id: "route",
    actor: "pedestrian",
    trigger: { kind: "at", t: 0 },
    until: { kind: "at", t: 20 },
    verb: "route",
    target: { mode: "customTimedRoute", points },
  };
}

describe("simple route status", () => {
  it("marks an overlapping placeholder route as needing setup", () => {
    expect(isUnconfiguredSimpleTimedRoute(route([
      { timeS: 0, x: 10, z: 20 },
      { timeS: 1, x: 10, z: 20 },
      { timeS: 20, x: 10, z: 20 },
    ]))).toBe(true);
  });

  it("recognizes a route once any point contains meaningful movement", () => {
    expect(isUnconfiguredSimpleTimedRoute(route([
      { timeS: 0, x: 10, z: 20 },
      { timeS: 1, x: 10.2, z: 20 },
    ]))).toBe(false);
  });

  it("does not classify non-route interactions", () => {
    expect(isUnconfiguredSimpleTimedRoute({
      id: "stop",
      actor: "pedestrian",
      trigger: { kind: "at", t: 1 },
      until: { kind: "at", t: 2 },
      verb: "speed",
      target: { mode: "stop" },
      dynamics: { shape: "step", constraint: "time", value: 0 },
    })).toBe(false);
  });
});
