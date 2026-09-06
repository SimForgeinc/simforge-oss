/** @vitest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ActorAppearanceSection } from "../../src/scenario/editor/inspector/ActorAppearanceSection";
import type { ActorRecord, EditorController } from "@simforge-oss/editor";

describe("ActorAppearanceSection parked authoring", () => {
  it("persists an explicit static flag for a mobile catalog actor", () => {
    const updateActorAppearance = vi.fn();
    const actor = {
      id: "occluder",
      source: "role",
      kind: "vehicle",
      catalogId: "vehicle.box_truck",
      label: "Occluder",
      x: 0,
      y: 0,
      z: 0,
      headingRad: 0,
      laneRef: undefined,
      dims: { l: 5, w: 2, h: 2 },
      bodyColor: undefined,
      initialSpeedKph: 0,
      static: false,
      sensors: [],
    } as ActorRecord;
    render(
      <ActorAppearanceSection
        actor={actor}
        controller={{ updateActorAppearance } as unknown as EditorController}
      />,
    );
    fireEvent.click(screen.getByLabelText("Static / parked"));
    expect(updateActorAppearance).toHaveBeenCalledWith("occluder", { static: true });
  });
});
