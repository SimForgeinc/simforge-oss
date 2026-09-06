import { describe, expect, it } from "vitest";
import {
  routePointWarningMessage,
  routePointMayBeTooFast,
  shouldShowRoutePointWarning,
} from "../../src/scenario/editor/route-authoring-warnings";

describe("route authoring warnings", () => {
  it("fires immediately when the live route draft adds a point", () => {
    expect(shouldShowRoutePointWarning({
      previousPointCount: 3,
      pointCount: 4,
      mode: "drawingRoute",
      tool: "add",
    })).toBe(true);
  });

  it("does not fire on entry, deletion, or while moving points", () => {
    expect(shouldShowRoutePointWarning({
      previousPointCount: null,
      pointCount: 1,
      mode: "drawingRoute",
      tool: "add",
    })).toBe(false);
    expect(shouldShowRoutePointWarning({
      previousPointCount: 4,
      pointCount: 3,
      mode: "drawingRoute",
      tool: "add",
    })).toBe(false);
    expect(shouldShowRoutePointWarning({
      previousPointCount: 3,
      pointCount: 4,
      mode: "drawingRoute",
      tool: "move",
    })).toBe(false);
  });

  it("uses the actor name and simple warning copy", () => {
    expect(routePointWarningMessage("Pedestrian")).toBe(
      "This sequence of points may make the pedestrian move too fast.",
    );
    expect(routePointWarningMessage()).toBe(
      "This sequence of points may make the actor move too fast.",
    );
  });

  it("evaluates only the newly created segment", () => {
    expect(routePointMayBeTooFast({
      actorKind: "pedestrian",
      from: { x: 0, z: 0 },
      to: { x: 8, z: 0 },
    })).toBe(true);
    expect(routePointMayBeTooFast({
      actorKind: "pedestrian",
      from: { x: 8, z: 0 },
      to: { x: 9, z: 0 },
    })).toBe(false);
  });
});
