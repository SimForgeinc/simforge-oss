import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EditorDocument, TEST_MAP } from "@simforge-oss/editor";
import { MemoryStorage, WebTemplateFileStore } from "@simforge-oss/scenario";
import type { Interaction } from "@simforge-oss/scenario";

import {
  driverInTheLoopContent,
  driverInTheLoopTitle,
  resolveDriverRole,
} from "../driver-in-the-loop";
import { driveHref } from "@simforge-oss/studio-ui/scenario/drive-route";

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

  it("displaces the driven actor's authored motion and leaves every other actor's alone", async () => {
    const document = await scenario();
    try {
      document.add([
        { id: "ego", catalogId: "vehicle.sedan", x: 10, y: 0, z: 5, headingRad: 0 },
        { id: "other", catalogId: "vehicle.sedan", x: 30, y: 0, z: 5, headingRad: 0 },
      ]);
      const timedRoute = (actor: string): Interaction => ({
        id: `simple_timed_route_${actor}`,
        actor,
        trigger: { kind: "at", t: 0 },
        until: { kind: "at", t: 1 },
        label: "Simple timed route",
        verb: "route",
        target: {
          mode: "customTimedRoute",
          points: [
            { timeS: 0, x: 10, z: 5 },
            { timeS: 1, x: 40, z: 5 },
          ],
        },
      });
      const authored = {
        ...document.data,
        choreography: {
          ...document.data.choreography,
          interactions: [timedRoute("ego"), timedRoute("other")],
        },
      };

      // The drive owns the driven actor's motion for the whole clip, and the
      // world the human drives is compiled from this content — an authored
      // route left on the driven actor is spawned and stepped by the engine,
      // so it has to be displaced before the drive rather than on save.
      const prepared = driverInTheLoopContent(authored, "ego");
      expect(prepared.choreography.interactions.map((interaction) => interaction.actor)).toEqual([
        "other",
      ]);
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

/**
 * The link the scenario list sends a driver down has to name the page that
 * actually serves the drive. It did not: `driveHref` pointed at
 * `/dashboard/scenario/<documentId>/drive`, which is not a route, so pressing
 * the gamepad button minted a variation and then landed on a 404. Nothing in
 * the unit suite could see that, because both halves were individually
 * correct. This asserts them against each other: the URL is turned back into
 * the App Router directory it claims and that directory must hold a page.
 */
describe("the route a drive is started on", () => {
  it("names the page that serves the drive", () => {
    const href = driveHref("uscn_abc", "vehicle-1");
    const { pathname, searchParams } = new URL(href, "http://studio.invalid");
    expect(searchParams.get("actor")).toBe("vehicle-1");

    const segments = pathname.slice(1).split("/");
    expect(segments.at(-1)).toBe("uscn_abc");
    // The document id is the dynamic segment; every other segment is literal.
    const routeDir = [...segments.slice(0, -1), "[documentId]"].join("/");
    const page = join(fileURLToPath(new URL("../../../..", import.meta.url)), "app", routeDir, "page.tsx");
    expect(existsSync(page)).toBe(true);
  });
});
