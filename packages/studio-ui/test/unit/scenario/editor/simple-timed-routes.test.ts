import { describe, expect, it } from "vitest";
import { MemoryStorage, WebTemplateFileStore } from "@simforge-oss/scenario";
import {
  EditorDocument,
  MAPS,
  setExclusiveCustomTimedRoute,
} from "@simforge-oss/editor";

import {
  EDITOR_EXPERIENCE_STORAGE_KEY,
  convertDocumentToSimpleTimedRoutes,
  isClipLockedSimpleRoute,
  isCustomTimedRoute,
  needsSimpleRouteConversion,
  readEditorExperience,
  simpleRouteTimes,
  writeEditorExperience,
} from "../../../../src/scenario/editor/simple-timed-routes";

describe("simple timed routes", () => {
  it("persists only supported editor experience values", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    expect(readEditorExperience(storage)).toBeNull();
    writeEditorExperience(storage, "advanced");
    expect(readEditorExperience(storage)).toBe("advanced");
    values.set(EDITOR_EXPERIENCE_STORAGE_KEY, "invalid");
    expect(readEditorExperience(storage)).toBeNull();
  });

  it("includes every whole second and an exact fractional clip end", () => {
    expect(simpleRouteTimes(3.5)).toEqual([0, 1, 2, 3, 3.5]);
  });

  // A custom gallery upload defaults to a movable class, so it is placed as a
  // role with an initial speed rather than a fixed prop. Simple mode must give it
  // the same timed route it gives a catalog robot or animal.
  it("routes a movable custom actor and leaves a static one alone", async () => {
    const document = await EditorDocument.open(MAPS[0]!, {
      store: new WebTemplateFileStore({ storage: new MemoryStorage() }),
      autosaveMs: 60_000,
    });
    document.setClip({ clipSeconds: 3, warmupSeconds: 0 });
    const [movableId] = document.add([{
      id: "custom_robot",
      catalogId: "sidewalk_robot.delivery_rover",
      x: 14,
      y: 0,
      z: 6,
      headingRad: 0,
    }]);
    const [parkedId] = document.add([{
      id: "parked_car",
      catalogId: "vehicle.sedan",
      x: 20,
      y: 0,
      z: 6,
      headingRad: 0,
      static: true,
    }]);

    convertDocumentToSimpleTimedRoutes(document);

    const movableMotion = document.data.choreography.interactions.filter(
      (interaction) => interaction.actor === movableId,
    );
    expect(movableMotion).toHaveLength(1);
    expect(isCustomTimedRoute(movableMotion[0]!)).toBe(true);
    expect(document.data.choreography.interactions.filter(
      (interaction) => interaction.actor === parkedId,
    )).toEqual([]);
    document.dispose();
  });

  it("leaves anchored road actors on the topology-owned connected route", async () => {
    const document = await EditorDocument.open(MAPS[0]!, {
      store: new WebTemplateFileStore({ storage: new MemoryStorage() }),
      autosaveMs: 60_000,
    });
    const [actorId] = document.add([{
      laneRef: { roadId: "1", section: 0, laneId: -1, s: 4, t: 0, headingOffsetRad: 0 },
      catalogId: "vehicle.sedan",
      x: 14,
      y: 0,
      z: 6,
      headingRad: 0,
    }]);
    convertDocumentToSimpleTimedRoutes(document);
    expect(document.data.choreography.interactions.filter((interaction) => interaction.actor === actorId)).toEqual([]);
    document.dispose();
  });
  it("replaces competing actor motion with one bounded placeholder route", async () => {
    const document = await EditorDocument.open(MAPS[0]!, {
      store: new WebTemplateFileStore({ storage: new MemoryStorage() }),
      autosaveMs: 60_000,
    });
    document.setClip({ clipSeconds: 3.5, warmupSeconds: 0 });
    const [actorId] = document.add([{
      id: "simple_car",
      catalogId: "vehicle.sedan",
      x: 12,
      y: 0,
      z: 4,
      headingRad: 0,
    }]);
    document.addInteraction({
      id: "old_speed",
      actor: actorId!,
      trigger: { kind: "at", t: 1 },
      verb: "speed",
      target: { mode: "absolute", valueKph: 80 },
      dynamics: { shape: "linear", constraint: "time", value: 1 },
    });

    convertDocumentToSimpleTimedRoutes(document);

    const motion = document.data.choreography.interactions.filter(
      (interaction) => interaction.actor === actorId,
    );
    expect(motion).toHaveLength(1);
    expect(isCustomTimedRoute(motion[0]!)).toBe(true);
    if (!isCustomTimedRoute(motion[0]!)) throw new Error("expected timed route");
    expect(motion[0].trigger).toEqual({ kind: "at", t: 0 });
    expect(motion[0].until).toEqual({ kind: "at", t: 3.5 });
    expect(motion[0].target.points).toEqual([
      { timeS: 0, x: 12, z: 4 },
      { timeS: 1, x: 12, z: 4 },
    ]);
    document.dispose();
  });

  it("makes direct timed-route creation full-width and exclusive for its actor", async () => {
    const document = await EditorDocument.open(MAPS[0]!, {
      store: new WebTemplateFileStore({ storage: new MemoryStorage() }),
      autosaveMs: 60_000,
    });
    document.setClip({ clipSeconds: 20, warmupSeconds: 0 });
    const [actorId] = document.add([{
      id: "advanced_car",
      catalogId: "vehicle.sedan",
      x: 12,
      y: 0,
      z: 4,
      headingRad: 0,
    }]);
    document.addInteraction({
      id: "old_speed",
      actor: actorId!,
      trigger: { kind: "at", t: 1 },
      verb: "speed",
      target: { mode: "absolute", valueKph: 50 },
      dynamics: { shape: "linear", constraint: "time", value: 1 },
    });
    document.addInteraction({
      id: "old_lane_change",
      actor: actorId!,
      trigger: { kind: "at", t: 2 },
      verb: "changeLane",
      target: { mode: "relative", dk: 1 },
      dynamics: { shape: "linear", constraint: "time", value: 1 },
    });

    setExclusiveCustomTimedRoute(document, {
      id: "timed_route",
      actor: actorId!,
      trigger: { kind: "at", t: 8 },
      until: { kind: "at", t: 12 },
      verb: "route",
      target: { mode: "customTimedRoute", points: [{ timeS: 0, x: 12, z: 4 }] },
    });

    const motion = document.data.choreography.interactions.filter(
      (interaction) => interaction.actor === actorId,
    );
    expect(motion).toHaveLength(1);
    expect(motion[0]).toEqual(expect.objectContaining({
      id: "timed_route",
      trigger: { kind: "at", t: 0 },
      until: { kind: "at", t: 20 },
    }));
    document.dispose();
  });

  it("preserves every authored time and position when locking a simple route", async () => {
    const document = await EditorDocument.open(MAPS[0]!, {
      store: new WebTemplateFileStore({ storage: new MemoryStorage() }),
      autosaveMs: 60_000,
    });
    document.setClip({ clipSeconds: 20, warmupSeconds: 0 });
    const [actorId] = document.add([{
      id: "partial_route_car",
      catalogId: "vehicle.sedan",
      x: 0,
      y: 0,
      z: 0,
      headingRad: 0,
    }]);
    document.addInteraction({
      id: "partial_simple_route",
      actor: actorId!,
      trigger: { kind: "at", t: 2 },
      until: { kind: "at", t: 8 },
      verb: "route",
      target: {
        mode: "customTimedRoute",
        points: [
          { timeS: 0, x: 1, z: 3 },
          { timeS: 10, x: 6, z: 8 },
          { timeS: 20, x: 11, z: 13 },
        ],
      },
    });

    expect(needsSimpleRouteConversion(document)).toBe(true);
    convertDocumentToSimpleTimedRoutes(document);

    const route = document.data.choreography.interactions.find(
      (interaction) => interaction.id === "partial_simple_route",
    );
    expect(route).toBeDefined();
    expect(isClipLockedSimpleRoute(route!, 20)).toBe(true);
    if (!route || !isCustomTimedRoute(route)) throw new Error("expected timed route");
    expect(route.target.points).toEqual([
      { timeS: 0, x: 1, z: 3 },
      { timeS: 10, x: 6, z: 8 },
      { timeS: 20, x: 11, z: 13 },
    ]);
    expect(needsSimpleRouteConversion(document)).toBe(false);
    document.dispose();
  });

});
