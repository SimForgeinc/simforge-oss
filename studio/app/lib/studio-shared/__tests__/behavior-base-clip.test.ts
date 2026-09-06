import { describe, expect, it } from "vitest";

import {
  baseActionForDraft,
  baseClip,
  isBaseClip,
  normalizeActorBaseClip,
  placementFieldsFromBaseClip,
  withBaseAction,
  withBaseSpeed,
} from "../behavior-base-clip";
import {
  emptyActorBehaviorProgram,
  type ActorBehaviorProgram,
} from "@simforge-oss/scenario/contracts";
import type { ScenarioEditorActorDraft } from "../scenario-editor";

/**
 * The base clip is what collapsed the editor's two competing control surfaces
 * into one. These pin the properties that collapse rests on: normalization is a
 * FIXED POINT (an actor's motion survives a load unchanged), the executable
 * fields the worker reads are compiled OUT of the clip, and a program that
 * already carries a baseline never gains a second one.
 */
function makeDraft(
  overrides: Partial<ScenarioEditorActorDraft> = {},
): ScenarioEditorActorDraft {
  return {
    id: "a1",
    label: "Car 1",
    kind: "vehicle",
    role: "traffic",
    is_static: false,
    placement_mode: "road",
    blueprint: "vehicle.dodge.charger",
    spawn: { road_id: "10", s_fraction: 0.5, lane_id: -1, section_id: 0 },
    spawn_point: null,
    route: [],
    route_direction: "forward",
    lane_facing: "with_lane",
    destination: null,
    destination_point: null,
    speed_kph: 30,
    color: null,
    sensors: [],
    ...overrides,
  } as ScenarioEditorActorDraft;
}

/** A road car whose author chose the Traffic Manager as its baseline. */
function autopilotProgram(actorId = "a1"): ActorBehaviorProgram {
  return {
    ...emptyActorBehaviorProgram(),
    clips: [
      {
        id: `bhv_base_${actorId}`,
        role: "base",
        enabled: true,
        trigger: { kind: "at_time", t: 0 },
        end: { kind: "completion" },
        action: { kind: "autopilot", enabled: true },
      },
    ],
  };
}

function autopilotDraft(
  overrides: Partial<ScenarioEditorActorDraft> = {},
): ScenarioEditorActorDraft {
  return makeDraft({ behavior: autopilotProgram(), ...overrides });
}

describe("baseActionForDraft", () => {
  it("reads a road car as a cruise at its commanded speed — never as autopilot", () => {
    expect(baseActionForDraft(makeDraft())).toEqual({
      kind: "cruise",
      speed_kph: 30,
    });
  });

  it("reads any static actor as a hold", () => {
    expect(baseActionForDraft(makeDraft({ is_static: true }))).toEqual({
      kind: "hold",
    });
  });

  it("mirrors a path actor's waypoints onto its baseline", () => {
    const waypoints = [{ x: 1, y: 2, time: 1 }];
    expect(
      baseActionForDraft(
        makeDraft({
          placement_mode: "timed_path",
          timed_waypoints: waypoints,
        } as Partial<ScenarioEditorActorDraft>),
      ),
    ).toEqual({ kind: "follow_path", waypoints, timed: true });
  });

  it("holds a path actor with no points yet — a path needs at least one", () => {
    expect(
      baseActionForDraft(
        makeDraft({ placement_mode: "timed_path" }),
      ),
    ).toEqual({ kind: "hold" });
  });
});

describe("normalizeActorBaseClip", () => {
  it("is a fixed point: an actor's motion survives normalizing twice", () => {
    for (const draft of [
      makeDraft(),
      autopilotDraft(),
      makeDraft({ is_static: true }),
      makeDraft({
        placement_mode: "timed_path",
        timed_waypoints: [{ x: 1, y: 2, time: 1 }],
      } as Partial<ScenarioEditorActorDraft>),
    ]) {
      const once = normalizeActorBaseClip(draft);
      expect(normalizeActorBaseClip(once)).toEqual(once);
      // ...and the placement fields the worker reads are unchanged by the
      // round trip, which is what makes normalizing on every edit safe.
      expect(once.placement_mode).toBe(draft.placement_mode);
      expect(once.is_static).toBe(draft.is_static);
    }
  });

  it("lets an authored baseline win over a stale is_static flag", () => {
    // Contradictory input. The base clip owns the placement tuple — it is
    // compiled OUT of the clip on every normalization — so an authored
    // autopilot baseline un-freezes the actor rather than being rewritten to a
    // hold behind the author's back.
    const resolved = normalizeActorBaseClip(
      makeDraft({ is_static: true, behavior: autopilotProgram() }),
    );
    expect(baseClip(resolved.behavior!)?.action).toEqual({ kind: "autopilot", enabled: true });
    expect(resolved.is_static).toBe(false);
    expect(normalizeActorBaseClip(resolved)).toEqual(resolved);
  });

  it("gives an actor with no program a cruise baseline at t=0", () => {
    const normalized = normalizeActorBaseClip(makeDraft());
    expect(normalized.behavior?.clips).toHaveLength(1);
    expect(normalized.behavior?.clips[0]).toMatchObject({
      role: "base",
      trigger: { kind: "at_time", t: 0 },
      end: { kind: "completion" },
      action: { kind: "cruise", speed_kph: 30 },
    });
  });

  it("prefers the first explicit base marker over the shape fallback", () => {
    const normalized = normalizeActorBaseClip(
      makeDraft({
        behavior: {
          ...emptyActorBehaviorProgram(),
          clips: [
            {
              id: "shape-base",
              enabled: true,
              trigger: { kind: "at_time", t: 0 },
              end: { kind: "completion" },
              action: { kind: "cruise", speed_kph: 10 },
            },
            {
              id: "marked-base",
              role: "base",
              enabled: true,
              trigger: { kind: "at_time", t: 8 },
              end: { kind: "completion" },
              action: { kind: "cruise", speed_kph: 42 },
            },
          ],
        },
      }),
    );
    expect(baseClip(normalized.behavior!)?.id).toBe("marked-base");
    expect(normalized.speed_kph).toBe(42);
    expect(normalized.behavior?.clips.map((clip) => clip.role)).toEqual([
      "interaction",
      "base",
    ]);
    expect(normalizeActorBaseClip(normalized)).toEqual(normalized);
  });

  it("stamps the shape fallback as base and every other clip as interaction", () => {
    const normalized = normalizeActorBaseClip({
      ...makeDraft(),
      behavior: {
        ...emptyActorBehaviorProgram(),
        clips: [
          {
            id: "unmarked-base",
            enabled: true,
            trigger: { kind: "at_time", t: 0 },
            end: { kind: "completion" },
            action: { kind: "cruise", speed_kph: 30 },
          },
          {
            id: "later",
            enabled: true,
            trigger: { kind: "at_time", t: 4 },
            end: { kind: "completion" },
            action: { kind: "stop" },
          },
        ],
      },
    });
    expect(normalized.behavior?.clips.map((clip) => clip.role)).toEqual([
      "base",
      "interaction",
    ]);
  });

  it("leaves an authored program's own baseline alone", () => {
    const authored = normalizeActorBaseClip(autopilotDraft());
    const retyped = {
      ...authored,
      behavior: withBaseAction(authored.behavior!, authored, {
        kind: "cruise",
        speed_kph: 12,
      }),
    };
    const normalized = normalizeActorBaseClip(retyped);
    expect(normalized.behavior?.clips).toHaveLength(1);
    expect(baseClip(normalized.behavior!)?.action).toEqual({
      kind: "cruise",
      speed_kph: 12,
    });
  });
});

describe("base clip normalization", () => {
  it("treats a conflict walker's proximity-armed crossing as its baseline", () => {
    // The crossing is the walker's only motion, so prepending a second
    // `walk_path` at t=0 would send it into the road immediately instead of
    // waiting for the car. See `crossWhenClip`.
    const waypoints = [{ x: 1, y: 2, time: 1 }];
    const program = {
      ...emptyActorBehaviorProgram(),
      clips: [
        {
          id: "cross",
          enabled: true,
          trigger: {
            kind: "proximity" as const,
            actor: "self" as const,
            other: { actor_id: "ego" },
            distance_m: 12,
            mode: "closer" as const,
          },
          end: { kind: "completion" as const },
          action: { kind: "walk_path" as const, waypoints },
        },
      ],
    };
    const walker = makeDraft({
      kind: "walker",
      placement_mode: "timed_path",
      timed_waypoints: waypoints,
    } as Partial<ScenarioEditorActorDraft>);

    const normalized = normalizeActorBaseClip({ ...walker, behavior: program });
    expect(normalized.behavior?.clips).toHaveLength(1);
    expect(baseClip(normalized.behavior!)?.id).toBe("cross");
  });
});

describe("placementFieldsFromBaseClip", () => {
  it("compiles each baseline back to the fields the worker reads", () => {
    const from = (draft: ScenarioEditorActorDraft) =>
      placementFieldsFromBaseClip(normalizeActorBaseClip(draft));

    expect(from(autopilotDraft())).toMatchObject({
      placement_mode: "road",
      autopilot: true,
      is_static: false,
    });
    expect(from(makeDraft())).toMatchObject({
      placement_mode: "road",
      autopilot: false,
      is_static: false,
      speed_kph: 30,
    });
    expect(from(makeDraft({ is_static: true }))).toMatchObject({
      is_static: true,
      autopilot: false,
      speed_kph: 0,
    });
  });

  it("does not freeze a points actor that has no points drawn yet", () => {
    // Its baseline is `hold`, but it is mid-authoring, not parked.
    const awaiting = normalizeActorBaseClip(
      makeDraft({
        placement_mode: "timed_path",
        timed_waypoints: [],
      } as Partial<ScenarioEditorActorDraft>),
    );
    expect(awaiting.is_static).toBe(false);
    expect(awaiting.placement_mode).toBe("timed_path");
  });

  it("moves a genuinely parked actor off timed_path", () => {
    // `timed_path` means "my position is a function of time", which cannot
    // survive being frozen.
    const parked = normalizeActorBaseClip(
      makeDraft({
        placement_mode: "timed_path",
        is_static: true,
      }),
    );
    expect(parked.placement_mode).toBe("point");
    expect(parked.is_static).toBe(true);
  });
});

describe("withBaseSpeed", () => {
  it("writes a cruising actor's speed through to its base clip", () => {
    const cruising = normalizeActorBaseClip(makeDraft());
    const faster = withBaseSpeed(cruising, 55);
    expect(faster.speed_kph).toBe(55);
    expect(baseClip(faster.behavior!)?.action).toEqual({
      kind: "cruise",
      speed_kph: 55,
    });
    // The recompile must agree, or the slider would appear not to work.
    expect(normalizeActorBaseClip(faster).speed_kph).toBe(55);
  });

  it("leaves a baseline that carries no speed of its own alone", () => {
    const autopiloted = normalizeActorBaseClip(autopilotDraft());
    const changed = withBaseSpeed(autopiloted, 55);
    expect(changed.speed_kph).toBe(55);
    expect(baseClip(changed.behavior!)?.action).toEqual({
      kind: "autopilot",
      enabled: true,
    });
  });
});

/**
 * Autopilot's desired speed became a field on the clip when the actor panel's
 * Navigation tab — and its speed slider — were retired. The worker still reads
 * `draft.speed_kph` (`spawn_actor_helpers.py::_apply_tm_speed_target`), so the
 * clip has to compile down to it, but only once someone has actually stated an
 * opinion.
 */
describe("autopilot desired speed", () => {
  it("does not claim the draft's speed until an author sets one", () => {
    const normalized = normalizeActorBaseClip(autopilotDraft({ speed_kph: 60 }));

    expect(baseClip(normalized.behavior!)?.action).toEqual({
      kind: "autopilot",
      enabled: true,
    });
    // The field stays freely writable, so a later direct write — a generator, a
    // .xosc import, a server reload — is not undone by the next recompile.
    const rewritten = normalizeActorBaseClip({ ...normalized, speed_kph: 20 });
    expect(rewritten.speed_kph).toBe(20);
  });

  it("compiles an authored clip speed down to the field the worker reads", () => {
    const normalized = normalizeActorBaseClip(autopilotDraft({ speed_kph: 60 }));
    const authored = withBaseAction(normalized.behavior!, normalized, {
      kind: "autopilot",
      enabled: true,
      speed_kph: 35,
    });

    const compiled = normalizeActorBaseClip({
      ...normalized,
      behavior: authored,
    });
    expect(compiled.speed_kph).toBe(35);
    // Idempotent: the recompile must not fight the value it just wrote.
    expect(normalizeActorBaseClip(compiled).speed_kph).toBe(35);
  });
});

describe("isBaseClip", () => {
  it("names only the first baseline, so a later locomotion clip stays ordinary", () => {
    const draft = normalizeActorBaseClip(makeDraft());
    const program = {
      ...draft.behavior!,
      clips: [
        ...draft.behavior!.clips,
        {
          id: "later",
          enabled: true,
          trigger: { kind: "at_time" as const, t: 4 },
          end: { kind: "completion" as const },
          action: { kind: "cruise" as const, speed_kph: 20 },
        },
      ],
    };
    expect(isBaseClip(program, program.clips[0]!.id)).toBe(true);
    expect(isBaseClip(program, "later")).toBe(false);
  });
});
