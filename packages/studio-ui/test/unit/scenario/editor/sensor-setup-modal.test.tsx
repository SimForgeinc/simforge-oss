// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultDashCamera,
  defaultLidar,
  instantiateSensorRig,
  sensorRigPreset,
  type ActorSensor,
  type ActorSpec,
} from "@simforge-oss/scenario";
import type { EditorDocument } from "@simforge-oss/editor";
import { SensorSetupModal } from "../../../../src/scenario/editor/inspector/SensorSetupModal";
import { PRONTO_SENSOR_RIG } from "../../../../src/scenario/editor/inspector/sensor-rig-presets";

/**
 * Sensor authoring used to be eleven numeric fields per sensor in a 192px rail.
 * These assertions defend what replaced it: one click fits a rig, LiDAR and
 * radar can be added at all, and named position/aim choices write real
 * geometry rather than merely highlighting a chip.
 */

afterEach(cleanup);

const CAR: ActorSpec = {
  class: "car",
  static: false,
  sensors: [],
  dims: { length: 4.7, width: 1.82, height: 1.45 },
} as ActorSpec;
const VAN: ActorSpec = {
  class: "van",
  static: false,
  sensors: [],
  dims: { length: 5.16, width: 2, height: 1.78 },
} as ActorSpec;
const PEDESTRIAN: ActorSpec = {
  class: "pedestrian",
  static: false,
  sensors: [],
  dims: { length: 0.6, width: 0.6, height: 1.75 },
} as ActorSpec;
const TRUCK: ActorSpec = {
  class: "truck",
  static: false,
  sensors: [],
  dims: { length: 9.5, width: 2.5, height: 3.5 },
} as ActorSpec;

function makeDocument(actor: ActorSpec) {
  const calls = {
    addActorSensor: vi.fn(),
    removeActorSensor: vi.fn(),
    replaceActorSensors: vi.fn(),
    updateActorSensor: vi.fn(),
  };
  return { ...calls, document: calls as unknown as EditorDocument, actor };
}

function open(actor: ActorSpec) {
  const harness = makeDocument(actor);
  render(
    <SensorSetupModal
      actor={actor}
      document={harness.document}
      label="Hatchback 1"
      onClose={vi.fn()}
      roleId="role_car"
    />,
  );
  return harness;
}

describe("sensor setup", () => {
  it("fits a whole production rig in one click", () => {
    const preset = sensorRigPreset("waymo-5th-gen");
    if (!preset) throw new Error("missing Waymo preset");
    const stale = defaultDashCamera(CAR);
    const harness = open({ ...CAR, sensors: [stale] } as ActorSpec);

    fireEvent.click(screen.getByRole("button", { name: `Fit ${preset.name}` }));

    expect(harness.replaceActorSensors).toHaveBeenCalledTimes(1);
    const [roleId, sensors] = harness.replaceActorSensors.mock.calls[0] as [string, ActorSensor[]];
    expect(roleId).toBe("role_car");
    expect(sensors).toHaveLength(preset.sensors.length);
    expect(sensors.map((sensor) => sensor.type).sort()).toEqual(
      preset.sensors.map((sensor) => sensor.type).sort(),
    );
    // A rig replaces the suite outright, so the previous sensor's id is gone.
    expect(sensors.some((sensor) => sensor.id === stale.id)).toBe(false);
  });

  it("offers Pronto Rig for a car and fits all port-E sensors with calibrated geometry", () => {
    const harness = open(CAR);

    fireEvent.click(screen.getByRole("button", { name: "Fit Pronto Rig" }));

    const [, sensors] = harness.replaceActorSensors.mock.calls[0] as [string, ActorSensor[]];
    expect(sensors).toHaveLength(18);
    expect(sensors.map((sensor) => sensor.id)).toEqual(
      PRONTO_SENSOR_RIG.sensors.map((sensor) => sensor.id),
    );
    expect(
      sensors.reduce<Record<string, number>>((counts, sensor) => {
        counts[sensor.type] = (counts[sensor.type] ?? 0) + 1;
        return counts;
      }, {}),
    ).toEqual({ dash_camera: 8, lidar: 6, radar: 4 });

    const cam0 = sensors[0];
    expect(PRONTO_SENSOR_RIG.sensors[0]?.id).toBe("pronto-cam0");
    expect(cam0?.mount.position).toEqual({ x: -0.1509, y: 0.0517, z: 0.7958 });
    expect(cam0?.mount.rotation.yawRad).toBeCloseTo(122 * Math.PI / 180);
    expect(cam0?.mount.rotation.pitchRad).toBeCloseTo(25 * Math.PI / 180);

  });

  it("offers the Pronto Rig for the Kia Carnival van sensor host", () => {
    const harness = open(VAN);
    const fit = screen.getByRole("button", { name: "Fit Pronto Rig" });
    expect((fit as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(fit);
    const [, sensors] = harness.replaceActorSensors.mock.calls[0] as [string, ActorSensor[]];
    expect(sensors).toHaveLength(18);
  });

  it("marks the rig the actor is already wearing", () => {
    const sensors = instantiateSensorRig("tesla-hw3", CAR);
    open({ ...CAR, sensors } as ActorSpec);
    expect(
      screen.getByRole("button", { name: "Fit Tesla Autopilot HW3" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen.getByRole("button", { name: "Fit Basic Dash Camera" }).getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("adds LiDAR and radar, which the old panel could not do at all", () => {
    const harness = open(CAR);

    fireEvent.click(screen.getByRole("button", { name: "Add LiDAR" }));
    fireEvent.click(screen.getByRole("button", { name: "Add Radar" }));

    const added = harness.addActorSensor.mock.calls.map(([, sensor]) => (sensor as ActorSensor).type);
    expect(added).toEqual(["lidar", "radar"]);
  });

  it.each([
    ["pedestrian", PEDESTRIAN],
    ["truck", TRUCK],
  ] as const)("offers cameras and every rig to a %s", (_name, actor) => {
    const harness = open(actor);
    const camera = screen.getByRole("button", { name: "Add Camera" });
    expect(camera.hasAttribute("disabled")).toBe(false);
    fireEvent.click(camera);
    expect(harness.addActorSensor.mock.calls[0]?.[1]).toMatchObject({ type: "dash_camera" });

    const rigButtons = screen.getAllByRole("button", { name: /^Fit / });
    expect(rigButtons.every((button) => !(button as HTMLButtonElement).disabled)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Fit Pronto Rig" }));
    const [, sensors] = harness.replaceActorSensors.mock.calls[0] as [string, ActorSensor[]];
    expect(sensors).toHaveLength(PRONTO_SENSOR_RIG.sensors.length);
  });

  it("moves a sensor to a named position without changing its id or its aim", () => {
    const lidar = { ...defaultLidar(CAR), mount: { position: { x: 0, y: 1, z: 0 }, rotation: { yawRad: 1, pitchRad: 0, rollRad: 0 } } };
    const harness = open({ ...CAR, sensors: [lidar] } as ActorSpec);

    fireEvent.click(screen.getByRole("button", { name: "Configure LiDAR" }));
    fireEvent.click(screen.getByRole("button", { name: "Front bumper" }));

    const [, sensorId, next] = harness.updateActorSensor.mock.calls[0] as [string, string, ActorSensor];
    expect(sensorId).toBe(lidar.id);
    expect(next.id).toBe(lidar.id);
    expect(next.mount.position.x).toBeCloseTo(2.35);
    expect(next.mount.rotation.yawRad).toBe(1);
  });

  it("aims a sensor left with a negative yaw, matching the document convention", () => {
    const lidar = defaultLidar(CAR);
    const harness = open({ ...CAR, sensors: [lidar] } as ActorSpec);

    fireEvent.click(screen.getByRole("button", { name: "Configure LiDAR" }));
    fireEvent.click(screen.getByRole("button", { name: "Left" }));

    const [, , next] = harness.updateActorSensor.mock.calls[0] as [string, string, ActorSensor];
    expect(next.mount.rotation.yawRad).toBeCloseTo(-Math.PI / 2);
    expect(next.mount.position).toEqual(lidar.mount.position);
  });

  it("clamps an out-of-range field of view instead of letting the schema reject the write", () => {
    const camera = defaultDashCamera(CAR);
    const harness = open({ ...CAR, sensors: [camera] } as ActorSpec);

    fireEvent.click(screen.getByRole("button", { name: "Configure Camera" }));
    fireEvent.change(screen.getByLabelText(`Far range in metres for Camera`), {
      target: { value: "-40" },
    });

    const [, , next] = harness.updateActorSensor.mock.calls[0] as [string, string, ActorSensor];
    expect(next.type).toBe("dash_camera");
    if (next.type !== "dash_camera") throw new Error("expected a camera");
    expect(next.camera.farM).toBeGreaterThan(next.camera.nearM);
  });

  it("gives every sensor's enable and remove control a unique accessible name", () => {
    const sensors = instantiateSensorRig("waymo-5th-gen", CAR);
    open({ ...CAR, sensors } as ActorSpec);

    const switches = screen.getAllByRole("switch").map((element) => element.getAttribute("aria-label"));
    expect(new Set(switches).size).toBe(sensors.length);
    const removes = screen
      .getAllByRole("button", { name: /^Remove / })
      .map((element) => element.getAttribute("aria-label"));
    expect(new Set(removes).size).toBe(sensors.length);
  });
});
