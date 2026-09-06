// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultDashCamera,
  isDashCamera,
  type Interaction,
} from "@simforge-oss/scenario";
import { ActorDetailsPanel } from "../../src/scenario/editor/inspector/ActorDetailsPanel";
import { InteractionActionPopover } from "../../src/scenario/editor/inspector/InteractionActionPopover";
import type {
  ActorRecord,
  EditorController,
  EditorDocument,
} from "@simforge-oss/editor";

/**
 * The inspector's failure mode is a dead input: it renders, it accepts typing,
 * and nothing reaches the document. Every assertion here is "the mutation
 * actually left the panel", because that is what silently regresses.
 */

afterEach(cleanup);

const VEHICLE: ActorRecord = {
  id: "role_ego",
  source: "role",
  kind: "vehicle",
  catalogId: "vehicle.sedan",
  label: "Ego",
  x: 12.345,
  y: 0.02,
  z: -6.789,
  headingRad: Math.PI / 2,
  laneRef: {
    roadId: "road-4",
    section: 0,
    laneId: -1,
    s: 41.5,
    t: 0.25,
    headingOffsetRad: 0,
  },
  dims: { l: 4.7, w: 1.82, h: 1.45 },
  bodyColor: undefined,
  initialSpeedKph: 30,
  driverProfile: "lawful",
  static: false,
  sensors: [],
};

const PEDESTRIAN: ActorRecord = {
  ...VEHICLE,
  id: "role_pedestrian",
  kind: "pedestrian",
  catalogId: "pedestrian.adult",
  label: "Pedestrian 1",
  dims: { l: 0.6, w: 0.6, h: 1.75 },
  initialSpeedKph: 5,
};

const OBJECT: ActorRecord = {
  ...VEHICLE,
  id: "prop_cone",
  source: "prop",
  kind: "prop",
  catalogId: "construction.traffic_cone",
  label: "Traffic cone 1",
  headingRad: Math.PI / 4,
  dims: { l: 0.45, w: 0.45, h: 0.75 },
  initialSpeedKph: undefined,
  static: true,
};

function makeController() {
  return {
    setLabel: vi.fn(),
    setWorldPose: vi.fn(),
    setLanePose: vi.fn(),
    updateActorAppearance: vi.fn(),
    frameActor: vi.fn(),
    duplicateSelection: vi.fn(),
    deleteSelection: vi.fn(),
  } as unknown as EditorController & Record<string, ReturnType<typeof vi.fn>>;
}

function makeDocument(actorClass = "car", sensors: unknown[] = [], actorId = VEHICLE.id) {
  const addActorSensor = vi.fn();
  const updateActorSensor = vi.fn();
  const replaceActorSensors = vi.fn();
  const document = {
    data: {
      roles: [
        {
          id: actorId,
          actor: {
            class: actorClass,
            dims: { length: 4.7, width: 1.82, height: 1.45 },
            sensors,
          },
        },
      ],
      choreography: { interactions: [], clipSeconds: 20, warmupSeconds: 0 },
    },
    addActorSensor,
    removeActorSensor: vi.fn(),
    replaceActorSensors,
    setMetricSubject: vi.fn(),
    updateActorSensor,
  } as unknown as EditorDocument;
  return { addActorSensor, document, replaceActorSensors, updateActorSensor };
}


describe("ActorDetailsPanel", () => {
  it("adds an enabled dash camera straight from the rail", () => {
    const { addActorSensor, document } = makeDocument();
    render(
      <ActorDetailsPanel
        actor={VEHICLE}
        controller={makeController()}
        document={document}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Add dash camera" }));

    expect(addActorSensor).toHaveBeenCalledOnce();
    const [roleId, sensor] = addActorSensor.mock.calls[0] as [
      string,
      Parameters<typeof isDashCamera>[0],
    ];
    expect(roleId).toBe(VEHICLE.id);
    expect(isDashCamera(sensor)).toBe(true);
    expect(sensor).toMatchObject({ enabled: true });
  });

  it("offers sensors for a pedestrian actor", () => {
    const { addActorSensor, document } = makeDocument("pedestrian", [], PEDESTRIAN.id);
    render(
      <ActorDetailsPanel
        actor={PEDESTRIAN}
        controller={makeController()}
        document={document}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Add dash camera" }));
    expect(addActorSensor).toHaveBeenCalledOnce();
    expect(addActorSensor.mock.calls[0]?.[0]).toBe(PEDESTRIAN.id);
  });

  /**
   * There is no ego designation to toggle any more: carrying a sensor is what
   * makes a vehicle the recording subject, so the panel reports a fact.
   */
  it("reports recording status from the sensors the vehicle carries", () => {
    const camera = defaultDashCamera({ class: "car", dims: { length: 4.7, width: 1.82, height: 1.45 } });
    const { rerender } = render(
      <ActorDetailsPanel actor={VEHICLE} controller={makeController()} document={makeDocument().document} onClose={vi.fn()} />,
    );
    expect(screen.queryByTestId("actor-records-scenario")).toBeNull();

    rerender(
      <ActorDetailsPanel
        actor={VEHICLE}
        controller={makeController()}
        document={makeDocument("car", [camera]).document}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId("actor-records-scenario").textContent).toContain("Records this scenario");
    expect(screen.getByTestId("actor-records-scenario").textContent).toContain("1 sensor fitted");
  });

  it("renders as a right-centered catalog card with model and paint controls", () => {
    const controller = makeController();
    const onClose = vi.fn();
    render(
      <ActorDetailsPanel
        actor={VEHICLE}
        controller={controller}
        document={makeDocument().document}
        onClose={onClose}
      />,
    );

    const panel = screen.getByTestId("scenario-actor-details-panel");
    expect(panel.getAttribute("data-placement")).toBe("right-centered");
    expect(panel.getAttribute("data-size")).toBe("compact");
    expect(panel.className).toContain("right-[calc(100%-100vw)]");
    expect(panel.className).toContain("top-1/2");
    // Width is the author's now: it opens a quarter under the 192px ceiling and the left edge
    // drags. A fixed width class here would have to be deleted to make the panel resizable at all.
    expect(panel.style.width).toBe("144px");
    expect(screen.getByTestId("editor-details-resize-handle")).not.toBeNull();
    expect(panel.className).toContain("rounded-l-xl");
    expect(panel.className).toContain("border-r-0");
    expect(panel.className).toContain("editor-actor-details-enter");
    expect(panel.className).not.toContain("editor-actor-popover-enter-right");
    expect(panel.style.maxHeight).toBe("min(560px, calc(100vh - 96px))");
    expect(screen.getByTestId("actor-details-model-preview").querySelector('[data-catalog-icon="vehicle.sedan"]')).not.toBeNull();
    expect(screen.getByLabelText("Name")).not.toBeNull();
    expect(screen.queryByText("4.7 × 1.8 × 1.4 m")).toBeNull();
    const speed = screen.getByLabelText("Initial speed") as HTMLInputElement;
    expect(speed.type).toBe("range");
    expect(speed.min).toBe("0");
    expect(speed.max).toBe("160");
    expect(screen.getByLabelText("Driver behavior")).not.toBeNull();
    expect(screen.getAllByRole("radio")).toHaveLength(4);
    expect(screen.getByRole("radiogroup", { name: "Driver behavior choices" }).className).toContain("grid-cols-1");
    const lawfulBehavior = screen.getByRole("radio", { name: /lawful.*behavior/i });
    expect(lawfulBehavior.getAttribute("aria-checked")).toBe("true");
    expect(lawfulBehavior.querySelector("img")?.getAttribute("src")).toContain("lawful.png");
    expect(screen.queryByText("0 sensors")).toBeNull();
    expect(panel.querySelector("header")?.contains(screen.getByRole("button", { name: "Navy" }))).toBe(true);
    expect(screen.queryByText("Placement")).toBeNull();
    expect(screen.queryByText(VEHICLE.id)).toBeNull();
    expect(screen.queryByRole("button", { name: "Frame" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Duplicate" })).toBeNull();
    expect(screen.queryByLabelText("Static / parked")).toBeNull();
    expect(screen.queryByLabelText("Rotation")).toBeNull();

    fireEvent.change(speed, { target: { value: "72" } });
    expect(controller.updateActorAppearance).toHaveBeenCalledWith(VEHICLE.id, {
      initialSpeedKph: 72,
    });

    fireEvent.click(screen.getByTestId("actor-details-close"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("updates the authored driver behavior through the controller", () => {
    const controller = makeController();
    render(
      <ActorDetailsPanel
        actor={VEHICLE}
        controller={controller}
        document={makeDocument().document}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "Assertive behavior" }));
    expect(controller.updateActorAppearance).toHaveBeenCalledWith(VEHICLE.id, {
      driverProfile: "assertive",
    });
  });

  it("hides route-derived motion controls in simple mode", () => {
    render(
      <ActorDetailsPanel
        actor={VEHICLE}
        controller={makeController()}
        document={makeDocument().document}
        onClose={vi.fn()}
        showMotionControls={false}
      />,
    );

    expect(screen.queryByLabelText("Initial speed")).toBeNull();
    expect(screen.queryByLabelText("Driver behavior")).toBeNull();
    expect(screen.getByLabelText("Name")).not.toBeNull();
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(
      <ActorDetailsPanel
        actor={VEHICLE}
        controller={makeController()}
        document={makeDocument().document}
        onClose={onClose}
      />,
    );

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("exposes persisted manual rotation for objects only", () => {
    const controller = makeController();
    render(
      <ActorDetailsPanel
        actor={OBJECT}
        controller={controller}
        document={makeDocument().document}
        onClose={vi.fn()}
      />,
    );

    const rotation = screen.getByLabelText("Rotation") as HTMLInputElement;
    expect(rotation.value).toBe("45");
    expect(rotation.step).toBe("5");
    fireEvent.change(rotation, { target: { value: "112.5" } });
    expect(controller.setWorldPose).toHaveBeenCalledWith("prop_cone", {
      headingDeg: 112.5,
    });
  });
});

describe("custom route details", () => {
  it("shows only Configure and delegates timestamp-aware authoring", () => {
    const onConfigureCustomRoute = vi.fn();
    const onClose = vi.fn();
    const interaction = {
      id: "route-custom",
      actor: VEHICLE.id,
      trigger: { kind: "at", t: 6 },
      until: { kind: "at", t: 20 },
      verb: "route",
      target: { mode: "customRoute", points: [{ x: 0, z: 0 }, { x: 1, z: 0 }] },
    } as Interaction;
    render(
      <InteractionActionPopover
        document={makeDocument().document}
        interaction={interaction}
        onClose={onClose}
        onConfigureCustomRoute={onConfigureCustomRoute}
      />,
    );

    expect(screen.getByTestId("scenario-custom-route-panel")).not.toBeNull();
    expect(screen.getAllByRole("button").filter((button) => button.textContent?.trim() === "Configure")).toHaveLength(1);
    expect(screen.queryByText("Starts")).toBeNull();
    expect(screen.queryByText("Redraw route")).toBeNull();
    expect(screen.queryByText("Continue drawing")).toBeNull();
    expect(screen.queryByText("Delete action")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Configure" }));
    expect(onConfigureCustomRoute).toHaveBeenCalledWith("route-custom");
    expect(onClose).toHaveBeenCalledOnce();
  });
});
