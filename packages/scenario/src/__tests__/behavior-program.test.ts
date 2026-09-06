import { describe, expect, it } from "vitest";

import {
  ACTOR_BEHAVIOR_SCHEMA_VERSION,
  ActorBehaviorProgramSchema,
  BEHAVIOR_ACTION_KINDS,
  BEHAVIOR_ROUTE_ANCHOR_CAP,
  BEHAVIOR_TRIGGER_KINDS,
  BehaviorClipSchema,
  BehaviorTriggerSchema,
  DEFAULT_BEHAVIOR_CLIP_END,
  DEFAULT_BEHAVIOR_TRIGGER,
  DIVERT_TAIL_MAX_M,
  DivertPathActionSchema,
  ReactionProfileSchema,
  ScenarioEditorRoadAnchorSchema,
  divertTailLengthM,
  quantizeBehaviorTimeSeconds,
  readBehaviorEvents,
  resolveDivertTail,
} from "../contracts.js";

describe("behavior vocabulary", () => {
  it("exposes every trigger kind the plan's condition table names", () => {
    expect([...BEHAVIOR_TRIGGER_KINDS]).toEqual([
      "at_time",
      "after_clip",
      "reach",
      "proximity",
      "ttc",
      "headway",
      "speed",
      "standstill",
      "signal_state",
    ]);
    const parsedKinds = BehaviorTriggerSchema.options.map((option) => option.shape.kind.value);
    expect(parsedKinds).toEqual([...BEHAVIOR_TRIGGER_KINDS]);
  });

  it("exposes every action kind in the plan's vocabulary table", () => {
    expect([...BEHAVIOR_ACTION_KINDS]).toEqual([
      "cruise",
      "stop",
      "creep",
      "reverse",
      "hold",
      "lane_change",
      "lane_offset",
      "turn_at_next_intersection",
      "follow_route",
      "follow_path",
      "go_to",
      "divert_path",
      "yield_to",
      "follow_actor",
      "intercept",
      "cut_in",
      "avoid",
      "autopilot",
      "walk_path",
    ]);
  });
});

describe("divert_path carries only what it may", () => {
  /**
   * The three absences are the design, so they are asserted rather than assumed.
   * `.strict()` turns each into a parse failure, which is what makes them
   * enforceable at all — a merely-undocumented field would be written by the
   * first caller that had one lying around.
   */
  it("takes clip-owned waypoints", () => {
    expect(
      DivertPathActionSchema.parse({
        kind: "divert_path",
        waypoints: [
          { x: 1, y: 2 },
          { x: 3, y: 4 },
        ],
      }).waypoints,
    ).toHaveLength(2);
  });

  it("refuses a speed of its own", () => {
    // The base clip already answered "how fast". A second answer here has no
    // tiebreak, so the field is absent rather than optional.
    expect(() =>
      DivertPathActionSchema.parse({
        kind: "divert_path",
        waypoints: [{ x: 1, y: 2 }],
        speed_kph: 40,
      }),
    ).toThrow();
  });

  it("refuses a schedule", () => {
    // `timed` means the waypoint times are a contract solved at generation time.
    // A divert fires off a trigger, so there is no such moment.
    expect(() =>
      DivertPathActionSchema.parse({
        kind: "divert_path",
        waypoints: [{ x: 1, y: 2 }],
        timed: true,
      }),
    ).toThrow();
  });

  it("needs at least one waypoint", () => {
    expect(() =>
      DivertPathActionSchema.parse({ kind: "divert_path", waypoints: [] }),
    ).toThrow();
  });
});

describe("behavior schema validation", () => {
  it("defaults a clip to an at_time=0 trigger, completion end and enabled", () => {
    const clip = BehaviorClipSchema.parse({
      id: "clip-a",
      action: { kind: "cruise", speed_kph: 30 },
    });
    expect(clip).toEqual({
      id: "clip-a",
      enabled: true,
      trigger: { kind: "at_time", t: 0 },
      end: { kind: "completion" },
      action: { kind: "cruise", speed_kph: 30 },
    });
  });

  it("defaults the program envelope", () => {
    expect(ActorBehaviorProgramSchema.parse({})).toEqual({
      schema_version: ACTOR_BEHAVIOR_SCHEMA_VERSION,
      clips: [],
      conflict_policy: "overwrite",
    });
  });

  it("accepts explicit clip roles and rejects multiple base clips", () => {
    const result = ActorBehaviorProgramSchema.safeParse({
      clips: [
        { id: "base-a", role: "base", action: { kind: "hold" } },
        { id: "base-b", role: "base", action: { kind: "cruise", speed_kph: 20 } },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/At most one clip.*base/);
    }
  });

  it.each(["follow_route", "follow_path", "walk_path"] as const)(
    "rejects %s on an interaction clip and accepts it as the base clip",
    (kind) => {
      const action =
        kind === "follow_route"
          ? { kind, anchors: [{ road_id: "road-1", s_fraction: 0.5 }] }
          : kind === "follow_path"
            ? { kind, waypoints: [{ x: 1, y: 2 }] }
            : { kind, waypoints: [{ x: 1, y: 2 }] };
      const interaction = ActorBehaviorProgramSchema.safeParse({
        clips: [{ id: "route", role: "interaction", action }],
      });
      expect(interaction.success).toBe(false);
      if (!interaction.success) {
        expect(interaction.error.issues[0]?.message).toBe(
          `${kind} is a route, not an interaction: its waypoints live on the actor, so it is only legal as the base clip.`,
        );
      }
      expect(
        ActorBehaviorProgramSchema.safeParse({
          clips: [{ id: "route", role: "base", action }],
        }).success,
      ).toBe(true);
    },
  );

  it("quantizes at_time triggers to the 0.1s authoring grid", () => {
    expect(BehaviorTriggerSchema.safeParse({ kind: "at_time", t: 4.2 }).success).toBe(true);
    expect(BehaviorTriggerSchema.safeParse({ kind: "at_time", t: 4.25 }).success).toBe(false);
    expect(BehaviorTriggerSchema.safeParse({ kind: "at_time", t: -1 }).success).toBe(false);
    expect(quantizeBehaviorTimeSeconds(4.267)).toBe(4.3);
    expect(quantizeBehaviorTimeSeconds(-3)).toBe(0);
  });

  it("requires positive distances and times on the conditional triggers", () => {
    expect(
      BehaviorTriggerSchema.safeParse({
        kind: "proximity",
        other: { actor_id: "ego" },
        distance_m: 0,
      }).success,
    ).toBe(false);
    expect(
      BehaviorTriggerSchema.safeParse({ kind: "ttc", other: { actor_id: "ego" }, seconds: 0 })
        .success,
    ).toBe(false);
    expect(
      BehaviorTriggerSchema.safeParse({ kind: "reach", point: { x: 1, y: 2 }, radius_m: -3 })
        .success,
    ).toBe(false);
    expect(
      BehaviorTriggerSchema.safeParse({ kind: "standstill", seconds: 2 }).success,
    ).toBe(true);
  });

  it("defaults the trigger subject to self and accepts an explicit actor ref", () => {
    const proximity = BehaviorTriggerSchema.parse({
      kind: "proximity",
      other: { actor_id: "ego" },
      distance_m: 20,
    });
    expect(proximity).toEqual({
      kind: "proximity",
      actor: "self",
      other: { actor_id: "ego" },
      distance_m: 20,
      mode: "closer",
    });
    expect(
      BehaviorTriggerSchema.safeParse({
        kind: "speed",
        actor: { actor_id: "car-2" },
        kph: 10,
        rule: "below",
      }).success,
    ).toBe(true);
    expect(
      BehaviorTriggerSchema.safeParse({ kind: "proximity", other: { actor_id: "" }, distance_m: 5 })
        .success,
    ).toBe(false);
  });

  it("rejects unknown parameters on the closed vocabularies", () => {
    expect(
      BehaviorClipSchema.safeParse({
        id: "clip-a",
        action: { kind: "cruise", speed_kph: 30, speedKph: 30 },
      }).success,
    ).toBe(false);
    expect(
      BehaviorTriggerSchema.safeParse({ kind: "at_time", t: 1, delay: 2 }).success,
    ).toBe(false);
  });

  it("requires follow_actor to carry a headway or a distance", () => {
    expect(
      BehaviorClipSchema.safeParse({
        id: "clip-a",
        action: { kind: "follow_actor", actor: { actor_id: "ego" } },
      }).success,
    ).toBe(false);
    expect(
      BehaviorClipSchema.safeParse({
        id: "clip-a",
        action: { kind: "follow_actor", actor: { actor_id: "ego" }, headway_s: 2 },
      }).success,
    ).toBe(true);
  });

  it("rejects a clip that waits on itself", () => {
    expect(
      BehaviorClipSchema.safeParse({
        id: "clip-a",
        trigger: { kind: "after_clip", clip_id: "clip-a" },
        action: { kind: "hold" },
      }).success,
    ).toBe(false);
  });

  it("caps follow_route anchors at 32 and requires at least one", () => {
    const anchor = { road_id: "road-1", s_fraction: 0.5 };
    const withCount = (count: number) =>
      BehaviorClipSchema.safeParse({
        id: "clip-a",
        action: { kind: "follow_route", anchors: Array.from({ length: count }, () => anchor) },
      }).success;
    expect(withCount(0)).toBe(false);
    expect(withCount(BEHAVIOR_ROUTE_ANCHOR_CAP)).toBe(true);
    expect(withCount(BEHAVIOR_ROUTE_ANCHOR_CAP + 1)).toBe(false);
  });

  it("applies the worker's defaults for creep and reverse speeds", () => {
    const creep = BehaviorClipSchema.parse({ id: "c", action: { kind: "creep" } });
    const reverse = BehaviorClipSchema.parse({ id: "r", action: { kind: "reverse" } });
    expect(creep.action).toEqual({ kind: "creep", speed_kph: 5 });
    expect(reverse.action).toEqual({ kind: "reverse", speed_kph: 10 });
  });

  it("keeps the reaction profile an actor-level knob with an explicit obstacle filter", () => {
    expect(ReactionProfileSchema.parse({ mode: "brake_and_swerve" })).toEqual({
      mode: "brake_and_swerve",
      aggressiveness: 0.5,
      exempt_actor_ids: [],
      obstacle_filter: "all",
    });
    expect(
      ReactionProfileSchema.parse({ mode: "brake", obstacle_filter: "stopped_vehicles" })
        .obstacle_filter,
    ).toBe("stopped_vehicles");
    expect(ReactionProfileSchema.safeParse({ mode: "brake", aggressiveness: 1.4 }).success).toBe(
      false,
    );
    expect(ReactionProfileSchema.safeParse({ mode: "swerve" }).success).toBe(false);
    expect(
      ReactionProfileSchema.safeParse({ mode: "brake", obstacle_filter: "walkers" }).success,
    ).toBe(false);
    expect(
      ReactionProfileSchema.safeParse({ mode: "brake", anti_plow: true }).success,
    ).toBe(false);
  });
});

describe("behavior events", () => {
  it("reads a well-formed behavior_events array off an artifact body", () => {
    expect(
      readBehaviorEvents({
        frames: [],
        behavior_events: [
          { actor_id: "a1", clip_id: "c1", kind: "trigger_fired", t: 4.2 },
        ],
      }),
    ).toEqual([
      { actor_id: "a1", clip_id: "c1", kind: "trigger_fired", t: 4.2 },
    ]);
  });

  it("treats an absent or unusable array as no events, never a throw", () => {
    for (const input of [
      null,
      undefined,
      "nope",
      [],
      { frames: [] },
      { behavior_events: null },
      { behavior_events: { actor_id: "a1" } },
    ]) {
      expect(readBehaviorEvents(input)).toEqual([]);
    }
  });

  it("drops malformed entries and strips unknown worker fields", () => {
    expect(
      readBehaviorEvents({
        behavior_events: [
          { actor_id: "a1", clip_id: "c1", kind: "trigger_fired", t: 0 },
          { actor_id: "a1", clip_id: "c2", kind: "trigger_fired", t: -1 },
          { clip_id: "c3", kind: "trigger_fired", t: 1 },
          {
            actor_id: "a1",
            clip_id: "c4",
            kind: "clip_ended",
            t: 2,
            reason: "until_trigger",
          },
        ],
      }),
    ).toEqual([
      { actor_id: "a1", clip_id: "c1", kind: "trigger_fired", t: 0 },
      { actor_id: "a1", clip_id: "c4", kind: "clip_ended", t: 2 },
    ]);
  });

});

describe("divert tail geometry", () => {
  it("puts forward along the heading and lateral to the LEFT", () => {
    // Heading east (yaw 0): forward is +x, left is +y.
    const [point] = resolveDivertTail([{ forward_m: 10, lateral_m: 3 }], {
      x: 0,
      y: 0,
      yawDeg: 0,
    });
    expect(point!.x).toBeCloseTo(10, 9);
    expect(point!.y).toBeCloseTo(3, 9);
    // Heading north (yaw 90): forward is +y, left is -x.
    const [north] = resolveDivertTail([{ forward_m: 10, lateral_m: 3 }], {
      x: 0,
      y: 0,
      yawDeg: 90,
    });
    expect(north!.x).toBeCloseTo(-3, 9);
    expect(north!.y).toBeCloseTo(10, 9);
  });

  it("measures the tail along the path, from the pose", () => {
    expect(divertTailLengthM([{ forward_m: 10, lateral_m: 0 }])).toBeCloseTo(10, 9);
    expect(
      divertTailLengthM([
        { forward_m: 0, lateral_m: 3 },
        { forward_m: 4, lateral_m: 3 },
      ]),
    ).toBeCloseTo(7, 9);
  });

  it("refuses a tail longer than the cap on the clip", () => {
    const clip = (forwardM: number) =>
      BehaviorClipSchema.safeParse({
        id: "divert",
        action: { kind: "divert_path", tail: [{ forward_m: forwardM, lateral_m: 0 }] },
      }).success;
    expect(clip(DIVERT_TAIL_MAX_M)).toBe(true);
    expect(clip(DIVERT_TAIL_MAX_M + 1)).toBe(false);
  });
});

describe("draft authoring defaults", () => {
  it("pins the behavior-program defaults both hosts read", () => {
    expect(DEFAULT_BEHAVIOR_TRIGGER).toEqual({ kind: "at_time", t: 0 });
    expect(DEFAULT_BEHAVIOR_CLIP_END).toEqual({ kind: "completion" });
    expect(ScenarioEditorRoadAnchorSchema.parse({ road_id: "17" })).toMatchObject({
      s_fraction: 0.5,
    });
  });
});
