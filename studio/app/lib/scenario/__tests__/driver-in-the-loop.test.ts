import { describe, expect, it } from "vitest";
import { EditorDocument, TEST_MAP } from "@simforge-oss/editor";
import { MemoryStorage, WebTemplateFileStore } from "@simforge-oss/scenario";

import {
  driverInTheLoopContent,
  driverInTheLoopTitle,
  resolveDriverRole,
} from "../driver-in-the-loop";

async function scenario(): Promise<EditorDocument> {
  return EditorDocument.openBlank(TEST_MAP, {
    store: new WebTemplateFileStore({ storage: new MemoryStorage() }),
    autosaveMs: 60_000,
  });
}

describe("resolving the actor a human takes over", () => {
  it("drives the only vehicle, and the declared subject once there are several", async () => {
    const document = await scenario();
    try {
      document.add([{ id: "ego", catalogId: "vehicle.sedan", x: 10, y: 0, z: 5, headingRad: 0 }]);
      expect(resolveDriverRole(document.data)).toEqual({ ok: true, roleId: "ego" });

      document.add([{ id: "other", catalogId: "vehicle.sedan", x: 30, y: 0, z: 5, headingRad: 0 }]);
      const ambiguous = resolveDriverRole(document.data);
      expect(ambiguous.ok).toBe(false);
      if (!ambiguous.ok) expect(ambiguous.reason).toMatch(/2 drivable vehicles/);

      // A scenario that names its measurement subject names the car to drive.
      const withSubject = { ...document.data, metricSubject: "other" };
      expect(resolveDriverRole(withSubject)).toEqual({ ok: true, roleId: "other" });
      // An explicit request still wins over the declared subject.
      expect(resolveDriverRole(withSubject, "ego")).toEqual({ ok: true, roleId: "ego" });
    } finally {
      document.dispose();
    }
  });

  it("refuses a scenario with nothing a person could drive", async () => {
    const document = await scenario();
    try {
      const empty = resolveDriverRole(document.data);
      expect(empty.ok).toBe(false);
      if (!empty.ok) expect(empty.reason).toMatch(/no drivable vehicle/);

      document.add([{ id: "walker", catalogId: "pedestrian.adult", x: 10, y: 0, z: 5, headingRad: 0 }]);
      const pedestrian = resolveDriverRole(document.data, "walker");
      expect(pedestrian.ok).toBe(false);
      if (!pedestrian.ok) expect(pedestrian.reason).toMatch(/cannot drive/);

      const missing = resolveDriverRole(document.data, "nobody");
      expect(missing.ok).toBe(false);
      if (!missing.ok) expect(missing.reason).toMatch(/no actor "nobody"/);
    } finally {
      document.dispose();
    }
  });
});

describe("the variation a drive is recorded into", () => {
  it("gives the driven actor a rig so the drive can be rendered, and keeps one it has", async () => {
    const document = await scenario();
    try {
      document.add([{ id: "ego", catalogId: "vehicle.sedan", x: 10, y: 0, z: 5, headingRad: 0 }]);
      const rigged = driverInTheLoopContent(document.data, "ego");
      const driven = rigged.roles.find((role) => role.id === "ego")!;
      expect(driven.actor.sensors.length).toBeGreaterThan(0);
      expect(driven.actor.sensors.some((sensor) => sensor.type === "dash_camera")).toBe(true);
      // Nothing else about the scenario changes: this is a copy of its parent
      // plus the rig, and the drive itself writes the clip later.
      expect({ ...rigged, roles: [] }).toEqual({ ...document.data, roles: [] });

      // An actor that already carries sensors is left exactly as authored.
      expect(driverInTheLoopContent(rigged, "ego")).toBe(rigged);
    } finally {
      document.dispose();
    }
  });

  it("numbers repeat drives of the same scenario", () => {
    expect(driverInTheLoopTitle("Cut-in", [])).toBe("Cut-in — Driver in the loop");
    expect(driverInTheLoopTitle("Cut-in", ["Cut-in — Driver in the loop"])).toBe(
      "Cut-in — Driver in the loop 2",
    );
    expect(
      driverInTheLoopTitle("Cut-in", [
        "Cut-in — Driver in the loop",
        "Cut-in — Driver in the loop 2",
      ]),
    ).toBe("Cut-in — Driver in the loop 3");
  });
});
