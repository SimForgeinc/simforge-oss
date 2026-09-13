import { parseSimScenarioInput } from "@simforge-oss/engine";
import { sessions, type WorldSession } from "@simforge-oss/training-env/node";
import { describe, expect, it } from "vitest";

import {
  applyEgoControl,
  createAuthoredWorldSession,
  holdEgoNeutral,
  releaseEgo,
} from "../../lib/live-world/authored-world-session";

const graph = sessions().engine.laneGraph({
  source: { xodrSha256: "fixture" },
  lanes: {},
  gates: [],
  junctions: {},
});

const DT = 0.02;
const TICKS_2S = Math.round(2 / DT);

/** An actor that, left alone, accelerates along its authored route to cruise. */
function worldInput(initialSpeedMps: number) {
  return parseSimScenarioInput({
    mapId: "drive-ego-ownership",
    clipSeconds: 20,
    warmupSeconds: 0,
    dt: DT,
    physics: { mode: "dynamic-v1" },
    actors: [{
      id: "ego",
      kind: "car",
      initial: { pose: { x: 0, z: 0, headingRad: 0 }, speedMps: initialSpeedMps },
      behavior: { route: { kind: "polyline", points: [{ x: 0, z: 0 }, { x: 400, z: 0 }] }, cruiseSpeedMps: 15 },
      tags: ["role:driver"],
    }],
  });
}

function egoOf(world: WorldSession) {
  return world.snapshot().actors.find((actor) => actor.id === "ego")!;
}

describe("Drive ego ownership", () => {
  it("a designated ego does not follow its authored route before any key is pressed", () => {
    const autonomous = createAuthoredWorldSession(sessions(), worldInput(0), graph);
    autonomous.advance(TICKS_2S);
    const autopilot = egoOf(autonomous);
    expect(autopilot.speedMps).toBeGreaterThan(5);

    const owned = createAuthoredWorldSession(sessions(), worldInput(0), graph);
    expect(holdEgoNeutral(owned, "ego", 0)).toEqual({ ok: true });
    owned.advance(TICKS_2S);
    const held = egoOf(owned);
    expect(held.speedMps).toBeLessThan(0.5);
    expect(held.x).toBeLessThan(autopilot.x / 10);
  });

  it("preserves the ego's physical velocity on takeover: it coasts instead of stopping or cruising", () => {
    const owned = createAuthoredWorldSession(sessions(), worldInput(10), graph);
    expect(holdEgoNeutral(owned, "ego", 0)).toEqual({ ok: true });
    owned.advance(5);
    const soon = egoOf(owned);
    // Neither braked to a stop nor accelerated toward the 15 m/s cruise.
    expect(soon.speedMps).toBeGreaterThan(8);
    expect(soon.speedMps).toBeLessThanOrEqual(10 + 1e-6);
    owned.advance(TICKS_2S);
    const later = egoOf(owned);
    expect(later.speedMps).toBeLessThan(soon.speedMps);
    expect(later.x).toBeGreaterThan(soon.x);
  });

  it("restores route following when the ego is released with a null action", () => {
    const world = createAuthoredWorldSession(sessions(), worldInput(0), graph);
    expect(holdEgoNeutral(world, "ego", 0)).toEqual({ ok: true });
    world.advance(TICKS_2S);
    expect(egoOf(world).speedMps).toBeLessThan(0.5);
    expect(releaseEgo(world, "ego", 1)).toEqual({ ok: true });
    world.advance(TICKS_2S);
    expect(egoOf(world).speedMps).toBeGreaterThan(5);
  });

  it("human input still drives an owned ego", () => {
    const world = createAuthoredWorldSession(sessions(), worldInput(0), graph);
    expect(holdEgoNeutral(world, "ego", 0)).toEqual({ ok: true });
    world.advance(10);
    expect(applyEgoControl(world, "ego", { actorId: "ego", steer: 0, throttle: 1, brake: 0 }, 1)).toEqual({ ok: true });
    world.advance(TICKS_2S);
    expect(egoOf(world).speedMps).toBeGreaterThan(5);
  });
});
