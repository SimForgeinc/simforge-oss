import { z } from "zod-v3";

/**
 * Studio actor-draft authoring contracts shared by both Studio hosts.
 *
 * Road-bound placement anchors (validated by the runtime-routes API and the
 * semantic actor compiler), the actor-level reaction profile that pairs with
 * the behavior program in `behavior-program.ts`, and the worker defaults the
 * behavior-program actions fall back to.
 *
 * Written against `zod-v3` because both hosts compose these schemas directly
 * into their zod-3 actor draft schemas.
 */

/** Worker defaults for behavior-program actions that omit an explicit value. */
export const DEFAULT_CREEP_SPEED_KPH = 5;
export const DEFAULT_REVERSE_SPEED_KPH = 10;
export const DEFAULT_FOLLOWING_DISTANCE_M = 5;
export const DEFAULT_REACTION_AGGRESSIVENESS = 0.5;
/** Distance at which a walker's conflict trigger fires when the author gives none. */
export const DEFAULT_WALKER_CONFLICT_TRIGGER_DISTANCE_M = 15;
/** Lane offset a `lane_offset` clip authored without a magnitude falls back to. */
export const DEFAULT_SWERVE_OFFSET_M = -1;

/** A behavior clip starts at t=0 unless the author picks another trigger. */
export const DEFAULT_BEHAVIOR_TRIGGER = { kind: "at_time", t: 0 } as const;
/** A behavior clip ends when its maneuver completes unless the author says otherwise. */
export const DEFAULT_BEHAVIOR_CLIP_END = { kind: "completion" } as const;

// ---------------------------------------------------------------------------
// Reaction profile (ACTOR-level, not a clip)
// ---------------------------------------------------------------------------

/**
 * The actor's reactive safety layer — one authored knob.
 *
 * It is an actor field, not a clip, because it is a standing property of the
 * actor rather than a scheduled maneuver: it must be able to interrupt whatever
 * clip is running (the reactive layer outranks clips unless the clip is
 * `intercept`).
 */
export const ReactionProfileModeSchema = z.enum(["none", "brake", "brake_and_swerve"]);
export type ReactionProfileMode = z.infer<typeof ReactionProfileModeSchema>;

/**
 * Which obstacles the reaction scans for.
 *
 * - `all`: every actor ahead — moving traffic, walkers, stopped vehicles.
 * - `stopped_vehicles`: ONLY vehicles that are at rest (within 16 m, moving
 *   below 0.5 m/s). The staged crosser stays assertive through its conflict —
 *   it does not brake for the moving ego it exists to cross in front of — but
 *   will not plow into a car that has already stopped dead ahead, and holds a
 *   standoff until that car moves again. Not a subset of `all` in effect: the
 *   broad scan brakes for the very ego this filter ignores.
 */
export const ReactionObstacleFilterSchema = z.enum(["all", "stopped_vehicles"]);
export type ReactionObstacleFilter = z.infer<typeof ReactionObstacleFilterSchema>;

export const ReactionProfileSchema = z
  .object({
    mode: ReactionProfileModeSchema,
    /** Scales the bounded lateral swerve offset: 0 = minimum, 1 = maximum. */
    aggressiveness: z.number().min(0).max(1).default(DEFAULT_REACTION_AGGRESSIVENESS),
    /**
     * Actors this one is ALLOWED to hit. Braking exemption only: the pursuit
     * obstacle scan skips them and the Traffic Manager gets a per-pair
     * `collision_detection(self, target, False)`. Conflict identity is the
     * draft's `intended_conflict_actor_id`, never this list.
     */
    exempt_actor_ids: z.array(z.string().trim().min(1)).default([]),
    obstacle_filter: ReactionObstacleFilterSchema.default("all"),
  })
  .strict();
export type ReactionProfile = z.infer<typeof ReactionProfileSchema>;

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

/** Road-bound placement: a spawn, route waypoint or destination on a CARLA road. */
export const ScenarioEditorRoadAnchorSchema = z.object({
  road_id: z.string(),
  s_fraction: z.number().min(0).max(1).default(0.5),
  lane_id: z.number().int().nullable().optional(),
  section_id: z.number().int().nullable().optional(),
  /** Controls the road segment from the previous road anchor to this anchor. */
  speed_kph: z.number().min(0).nullable().optional(),
  /** Semantic compiler output must resolve this exact OpenDRIVE anchor. */
  resolution_mode: z.literal("runtime_exact").optional(),
  /** Authoritative WORLD position (runtime/frontend frame: x, y, z meters + yaw
   * degrees), sampled from the accepted runtime-map lane centerline at
   * `s_fraction`. Persisted editor drafts may omit it, but CARLA UE5 execution
   * must not infer placement from a road id after runtime-exact semantic
   * compilation because UE5 can renumber or reuse the UE4 OpenDRIVE id. */
  world_anchor: z
    .object({
      x: z.number(),
      y: z.number(),
      z: z.number(),
      yaw: z.number(),
    })
    .optional(),
});
export type ScenarioEditorRoadAnchor = z.infer<typeof ScenarioEditorRoadAnchorSchema>;
