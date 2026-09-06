// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActorSensorSchema } from "@simforge-oss/scenario";
import { ActorCameras } from "../../../../src/scenario/editor/timeline/ActorCameras";

afterEach(cleanup);

const document = {
  addActorSensor: vi.fn(),
  removeActorSensor: vi.fn(),
  updateActorSensor: vi.fn(),
};

function role(actorClass: "car" | "pedestrian", sensors: unknown[] = []) {
  return {
    id: `${actorClass}-role`,
    actor: { class: actorClass, sensors },
  };
}

describe("ActorCameras", () => {
  it("offers Camera to car and pedestrian actors supported by the canonical mount", () => {
    const view = render(
      <ActorCameras document={document as never} role={role("car") as never} />,
    );
    expect(screen.getByRole("button", { name: "Camera" })).not.toBeNull();

    view.rerender(
      <ActorCameras
        document={document as never}
        role={role("pedestrian") as never}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Camera" }));
    expect(document.addActorSensor).toHaveBeenCalledWith(
      "pedestrian-role",
      expect.objectContaining({ type: "dash_camera" }),
    );
  });

  it("shows and edits camera, LiDAR, and radar without ambiguous control names", () => {
    const sensors = [
      ActorSensorSchema.parse({
        id: "camera-front",
        type: "dash_camera",
        label: "Front",
        mount: { position: { x: 1, y: 1, z: 0 } },
      }),
      ActorSensorSchema.parse({
        id: "lidar-roof",
        type: "lidar",
        label: "Roof",
        mount: { position: { x: 0, y: 2, z: 0 } },
      }),
      ActorSensorSchema.parse({
        id: "radar-front",
        type: "radar",
        label: "Front",
        mount: { position: { x: 2, y: 0.5, z: 0 } },
      }),
    ];
    render(
      <ActorCameras
        document={document as never}
        role={role("car", sensors) as never}
      />,
    );

    expect(screen.getByText("1 camera · 1 LiDAR · 1 radar")).not.toBeNull();
    const radarToggle = screen.getByRole("switch", {
      name: "Front (radar-front) enabled in timeline",
    });
    fireEvent.click(radarToggle);
    expect(document.updateActorSensor).toHaveBeenCalledWith(
      "car-role",
      "radar-front",
      expect.objectContaining({ id: "radar-front", enabled: false }),
    );
    expect(
      screen.getByRole("button", {
        name: "Remove Front (camera-front) from timeline",
      }),
    ).not.toBeNull();
    expect(
      screen.getByRole("button", {
        name: "Remove Front (radar-front) from timeline",
      }),
    ).not.toBeNull();
  });
});
