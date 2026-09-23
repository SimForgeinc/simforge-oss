import { describe, expect, it } from "vitest";
import type { Interaction, ManualDriveRecording, ScenarioTemplateV2 } from "@simforge-oss/scenario";
import {
  INITIAL_TAKE_STATE,
  isDeliberateControl,
  motionReplacedByTake,
  takeReducer,
  templateWithTake,
  type TakeAction,
  type TakeState,
} from "../take-state";

const recording: ManualDriveRecording = {
  version: 1,
  clipSeconds: 20,
  samples: [
    { timeS: 0, x: 0, y: 0, z: 0, headingRad: 0, speedMps: 0 },
    { timeS: 20, x: 50, y: 0, z: 0, headingRad: 0, speedMps: 5 },
  ],
};

function run(actions: readonly TakeAction[], from: TakeState = INITIAL_TAKE_STATE): TakeState {
  return actions.reduce(takeReducer, from);
}

describe("take state machine", () => {
  it("starts loading and records nothing on its own", () => {
    expect(INITIAL_TAKE_STATE).toEqual({ kind: "loading" });
    // Becoming interactive only arms the take.
    expect(run([{ type: "interactive" }])).toEqual({ kind: "ready" });
  });

  it("cannot start before the map is interactive", () => {
    const state = run([{ type: "start" }]);
    expect(state).toEqual({ kind: "loading" });
    // A start pressed while loading is not remembered for later either.
    expect(run([{ type: "start" }, { type: "interactive" }])).toEqual({ kind: "ready" });
  });

  it("goes back to loading if the map goes away before a take starts", () => {
    expect(run([{ type: "interactive" }, { type: "not-interactive" }])).toEqual({ kind: "loading" });
  });

  it("ignores a finished recording that nobody started", () => {
    // A stray worker event must never produce a take to keep.
    expect(run([{ type: "recorded", recording }])).toEqual({ kind: "loading" });
    expect(run([{ type: "interactive" }, { type: "recorded", recording }])).toEqual({ kind: "ready" });
  });

  it("holds a finished take for review instead of saving it", () => {
    const state = run([{ type: "interactive" }, { type: "start" }, { type: "recorded", recording }]);
    expect(state).toEqual({ kind: "review", recording });
  });

  it("does not leave review without keep or discard", () => {
    const review = run([{ type: "interactive" }, { type: "start" }, { type: "recorded", recording }]);
    for (const action of [
      { type: "start" },
      { type: "interactive" },
      { type: "not-interactive" },
      { type: "saved" },
      { type: "save-failed", message: "x" },
      { type: "record-failed", message: "x" },
    ] as const) {
      expect(takeReducer(review, action)).toBe(review);
    }
  });

  it("saves only through keep", () => {
    const saved = run([
      { type: "interactive" },
      { type: "start" },
      { type: "recorded", recording },
      { type: "keep" },
    ]);
    expect(saved).toEqual({ kind: "saving", recording });
    expect(takeReducer(saved, { type: "saved" })).toEqual({ kind: "saved" });
  });

  it("a second keep while saving changes nothing", () => {
    const saving: TakeState = { kind: "saving", recording };
    expect(takeReducer(saving, { type: "keep" })).toBe(saving);
    expect(takeReducer(saving, { type: "discard" })).toBe(saving);
  });

  it("discard throws the take away and re-arms", () => {
    const state = run([{ type: "interactive" }, { type: "start" }, { type: "recorded", recording }, { type: "discard" }]);
    expect(state).toEqual({ kind: "ready" });
  });

  it("a failed save keeps the recording, to keep again or discard", () => {
    const failed = run([{ type: "save-failed", message: "HTTP 409" }], { kind: "saving", recording });
    expect(failed).toEqual({ kind: "failed", message: "HTTP 409", recording });
    // Driving over an unsaved take is not offered.
    expect(takeReducer(failed, { type: "start" })).toBe(failed);
    expect(takeReducer(failed, { type: "keep" })).toEqual({ kind: "saving", recording });
    expect(takeReducer(failed, { type: "discard" })).toEqual({ kind: "ready" });
  });

  it("a failed recording can be driven again", () => {
    const failed = run([{ type: "interactive" }, { type: "start" }, { type: "record-failed", message: "dropped frames" }]);
    expect(failed).toEqual({ kind: "failed", message: "dropped frames", recording: null });
    expect(takeReducer(failed, { type: "keep" })).toBe(failed);
    expect(takeReducer(failed, { type: "start" })).toEqual({ kind: "recording" });
  });
});

describe("deliberate control input", () => {
  it("ignores resting and drifting devices", () => {
    expect(isDeliberateControl({ throttle: 0, brake: 0, steer: 0 })).toBe(false);
    expect(isDeliberateControl({ throttle: 0.2, brake: 0.1, steer: -0.3 })).toBe(false);
  });

  it("counts a real pedal or wheel input", () => {
    expect(isDeliberateControl({ throttle: 1, brake: 0, steer: 0 })).toBe(true);
    expect(isDeliberateControl({ throttle: 0, brake: 0.6, steer: 0 })).toBe(true);
    expect(isDeliberateControl({ throttle: 0, brake: 0, steer: -0.8 })).toBe(true);
  });
});

describe("applying a kept take", () => {
  const route = {
    id: "route_car",
    actor: "car",
    trigger: { kind: "at", t: 0 },
    until: { kind: "at", t: 20 },
    label: "Simple timed route",
    verb: "route",
    target: { mode: "customTimedRoute", points: [{ timeS: 0, x: 0, z: 0 }, { timeS: 4, x: 10, z: 0 }] },
  } as unknown as Interaction;
  const otherActor = { ...route, id: "route_other", actor: "other" } as Interaction;
  const template = {
    choreography: { clipSeconds: 20, warmupSeconds: 0, interactions: [route, otherActor] },
  } as unknown as ScenarioTemplateV2;

  it("reports the motion a take would replace", () => {
    expect(motionReplacedByTake(template, "car").map((interaction) => interaction.id)).toEqual(["route_car"]);
    expect(motionReplacedByTake(template, "nobody")).toEqual([]);
  });

  it("replaces the actor's motion without touching the input or other actors", () => {
    const next = templateWithTake(template, "car", recording);
    expect(template.choreography.interactions).toEqual([route, otherActor]);
    const ids = next.choreography.interactions.map((interaction) => interaction.id);
    expect(ids).toEqual(["route_other", "manual_drive_car"]);
    const take = next.choreography.interactions[1]!;
    expect(take.verb).toBe("route");
    expect((take.target as { mode: string }).mode).toBe("manualDrive");
  });

  it("a second take replaces the first in place and keeps its label", () => {
    const first = templateWithTake(template, "car", recording);
    const labelled = {
      ...first,
      choreography: {
        ...first.choreography,
        interactions: first.choreography.interactions.map((interaction) =>
          interaction.id === "manual_drive_car" ? { ...interaction, label: "Lap 1" } : interaction),
      },
    } as ScenarioTemplateV2;
    const second = templateWithTake(labelled, "car", { ...recording, samples: [...recording.samples] });
    expect(second.choreography.interactions.map((interaction) => interaction.id)).toEqual(["route_other", "manual_drive_car"]);
    expect(second.choreography.interactions[1]!.label).toBe("Lap 1");
  });
});
