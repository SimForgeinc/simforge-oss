import {
  behaviorActorRef,
  type BehaviorAction,
  type Sensor,
} from "@simforge-oss/scenario/contracts";
import {
  applyAggressivenessToSpeedKph,
  type CollisionActorRecipe,
  type CollisionActorRole,
  type CollisionClipTemplate,
  type NpcAggressiveness,
  type ScenarioEditorActorDraft,
} from "@simforge-oss/studio-shared";
import {
  PRESET_SDG_AV,
  sensorsFromPreset,
} from "@/app/lib/scenario-editor/sensor-rigs";
import type { GeometryLaneSample } from "@/app/lib/maps/search/server/inspect-location-geometry";
import {
  buildActorLabel,
  defaultActorColor,
} from "@/app/lib/scenario-editor/actor-utils";
import {
  spawnYawDegFromPlannedPath,
  type PlanCollisionRoutesResult,
  type PlannedActor,
  type PlannedWalker,
} from "@/app/lib/llm/scenario-generation/collision-route-planner";
import {
  buildRoadAnchor,
  emptyNonRoadSpawnAnchor,
  fallbackAnchorForLaneId,
  type ActorPlacement,
} from "@/app/lib/llm/scenario-generation/collision-anchor-resolution";
import {
  authorGeneratedActor,
  type GeneratedInteractionClip,
} from "@/app/lib/scenario-generation/generated-actor-behavior";

type CollisionTemplateForAssembly = {
  durationSeconds: number;
  actorRecipe: readonly CollisionActorRecipe[];
};

export type NpcVehicleOverride = {
  blueprint: string;
  baseSpeedKph: number;
} | null;

/**
 * Default sensor rig for an auto-generated subject actor: the physical
 * sensors of `PRESET_SDG_AV` (NVIDIA Sensor Config) — the same full-coverage
 * rig used for hand-authored SDG scenarios:
 *   - 7× RGB cameras (front center / front left / front right / left side /
 *     right side / rear left / rear right) at 1920×1208, 120° FOV.
 *   - 1× roof-center LiDAR (128 channels, 250 m range).
 *
 * The preset's spring-arm trailing preview camera rides with the rig: the
 * native lowering (`lowerCollisionDraftCandidate`) carries it as the
 * platform's trailing presentation view (`chase-cam-trailing`), an explicit
 * RGB render view outside the measurement rig, with its authored capture
 * format in the template's render defaults.
 *
 * Auto-generated scenarios get the heavy rig by default; users filter down
 * to 1–2 cameras at render-submission time. NPC vehicles and walkers stay
 * sensor-less (standard AV data-collection convention).
 *
 * `sensorsFromPreset` mints fresh UUIDs per call, so each subject in a draft
 * gets distinct sensor ids.
 *
 * @internal Exported for unit tests.
 */
export function defaultActorSensors(
  isSubject: boolean,
): Sensor[] {
  if (!isSubject) return [];
  return sensorsFromPreset(PRESET_SDG_AV).map((sensor) => ({ ...sensor, attachTo: "subject" }));
}

function timedWaypointsForPlannedActor(
  planned: PlannedActor,
): NonNullable<ScenarioEditorActorDraft["timed_waypoints"]> {
  const speedMps = Math.max(0.1, planned.expectedSpeedKph / 3.6);
  let elapsed = 0;
  return planned.waypoints.slice(1).map((waypoint, index) => {
    const previous = planned.waypoints[index] ?? planned.spawnPoint;
    elapsed += Math.hypot(waypoint.x - previous.x, waypoint.y - previous.y) / speedMps;
    return {
      x: waypoint.x,
      y: waypoint.y,
      time: elapsed,
      speed_kph: planned.expectedSpeedKph,
    };
  });
}

/** A clip template's end, as the clip's own `end`: a span becomes a duration. */
function clipEndForSpan(startTime: number, endTime: number | undefined) {
  if (endTime == null || endTime <= startTime) return undefined;
  return { kind: "duration" as const, seconds: Math.round((endTime - startTime) * 1000) / 1000 };
}

/**
 * A clip template's action with its speed resolved (the family's
 * aggressiveness multiplier applied) and its `target_role` bound to the actor
 * id the builder minted for that role. A converging clip whose target role
 * was not built is a speed command.
 */
function resolveClipAction(
  clip: CollisionClipTemplate,
  speedKph: number,
  roleIdMap: Record<string, string>,
): BehaviorAction {
  const cruise: BehaviorAction = { kind: "cruise", speed_kph: speedKph };
  switch (clip.action) {
    case "cruise":
      return cruise;
    case "intercept": {
      const targetId = roleIdMap[clip.target_role];
      return targetId
        ? { kind: "intercept", actor: behaviorActorRef(targetId), speed_kph: speedKph }
        : cruise;
    }
    case "follow_actor": {
      const targetId = roleIdMap[clip.target_role];
      return targetId
        ? {
            kind: "follow_actor",
            actor: behaviorActorRef(targetId),
            distance_m: clip.distance_m,
            max_speed_kph: speedKph,
          }
        : cruise;
    }
  }
}

/** The recipe's interaction clips, resolved against the built actor set. */
function resolveInteractionClips(
  recipe: CollisionActorRecipe,
  aggressiveness: NpcAggressiveness,
  roleIdMap: Record<string, string>,
): GeneratedInteractionClip[] {
  return recipe.clips.map((clip, index) => {
    const speedKph =
      recipe.aggressivenessAppliesTo === "speed"
        ? applyAggressivenessToSpeedKph(clip.speed_kph, aggressiveness)
        : clip.speed_kph;
    const end = clipEndForSpan(clip.start_time, clip.end_time);
    return {
      id: `clip-${recipe.role}-${index}`,
      trigger: { kind: "at_time", t: Math.round(clip.start_time * 10) / 10 },
      ...(end ? { end } : {}),
      action: resolveClipAction(clip, speedKph, roleIdMap),
    };
  });
}

export function buildCollisionDraftActors(input: {
  template: CollisionTemplateForAssembly;
  plannerResult: PlanCollisionRoutesResult | null;
  rolePlacements: Partial<Record<CollisionActorRole, ActorPlacement>>;
  roleIdMap: Record<string, string>;
  npcOverride: NpcVehicleOverride;
  aggressiveness: NpcAggressiveness;
  subjectAnchor: GeometryLaneSample | null;
  subjectPedestrianDestination: { x: number; y: number } | null;
}): ScenarioEditorActorDraft[] {
  const {
    template,
    plannerResult,
    rolePlacements,
    roleIdMap,
    npcOverride,
    aggressiveness,
    subjectAnchor,
    subjectPedestrianDestination,
  } = input;
  const actors: ScenarioEditorActorDraft[] = [];
  for (const recipe of template.actorRecipe) {
    const id = roleIdMap[recipe.role]!;
    // For the NPC, apply the vehicle-type override's base speed when
    // present so a cyclist NPC doesn't end up driving at car speed.
    const effectiveBaseSpeed =
      recipe.role !== "subject" && npcOverride
        ? npcOverride.baseSpeedKph
        : recipe.baseSpeedKph;
    const speed = recipe.aggressivenessAppliesTo === "speed"
      ? applyAggressivenessToSpeedKph(effectiveBaseSpeed, aggressiveness)
      : effectiveBaseSpeed;

    // Planner-emit branch.
    if (plannerResult) {
      const planned: PlannedActor | null =
        recipe.role === "subject"
          ? plannerResult.collision.subject
          : recipe.kind === "vehicle"
            ? plannerResult.collision.npc
            : null;
      const walker: PlannedWalker | null =
        recipe.kind === "walker" ? plannerResult.walker : null;

      if (recipe.kind === "vehicle" && planned) {
        const spawnAnchor = fallbackAnchorForLaneId(planned.spawnLaneId, planned.spawnSFraction)
          ?? emptyNonRoadSpawnAnchor();
        // Apply the NPC vehicle-type override (cyclist / motorcycle)
        // when the LLM passed one. Subject always keeps the recipe's
        // blueprint — the override targets the conflicting NPC only.
        const blueprint =
          recipe.role !== "subject" && npcOverride
            ? npcOverride.blueprint
            : recipe.blueprint;
        const actor: ScenarioEditorActorDraft = {
          id,
          label: buildActorLabel(
            {
              kind: recipe.kind,
              role: recipe.scenarioRole,
              placement_mode: "timed_path",
              is_static: false,
              blueprint,
            },
            actors,
          ),
          kind: recipe.kind,
          role: recipe.scenarioRole,
          is_static: false,
          placement_mode: "timed_path",
          blueprint,
          spawn: spawnAnchor,
          spawn_point: planned.spawnPoint,
          // Heading from the planned path's first segment — robust to
          // OpenDRIVE lane-id sign / bidirectional lanes (see
          // spawnYawDegFromPlannedPath). Replaces the old blanket +180°.
          spawn_yaw: spawnYawDegFromPlannedPath(planned),
          route: [],
          route_direction: "forward",
          lane_facing: "with_lane",
          destination: null,
          destination_point: null,
          path_placement: [],
          timed_waypoints: timedWaypointsForPlannedActor(planned),
          speed_kph: planned.expectedSpeedKph,
          color: defaultActorColor({ kind: recipe.kind }),
          sensors: defaultActorSensors(recipe.role === "subject"),
        };
        // The timed path IS the spec: the base clip follows it through the
        // worker's path controller, and the recipe's clips are dropped in
        // favour of one constant cruise so the path-follower receives a
        // constant target. The maneuver itself (the left turn / lane change)
        // is encoded by the planner's waypoint geometry.
        actors.push(
          authorGeneratedActor(actor, {
            interactions: [
              {
                id: `clip-${recipe.role}-0`,
                end: clipEndForSpan(0, template.durationSeconds),
                action: { kind: "cruise", speed_kph: planned.expectedSpeedKph },
              },
            ],
          }),
        );
        continue;
      }
      if (recipe.kind === "walker" && walker) {
        const actor: ScenarioEditorActorDraft = {
          id,
          label: buildActorLabel(
            {
              kind: recipe.kind,
              role: recipe.scenarioRole,
              placement_mode: "timed_path",
              is_static: false,
              blueprint: recipe.blueprint,
            },
            actors,
          ),
          kind: recipe.kind,
          role: recipe.scenarioRole,
          is_static: false,
          placement_mode: "timed_path",
          blueprint: recipe.blueprint,
          spawn: emptyNonRoadSpawnAnchor(),
          spawn_point: walker.spawnPoint,
          spawn_yaw: undefined,
          route: [],
          route_direction: "forward",
          lane_facing: "with_lane",
          destination: null,
          destination_point: null,
          speed_kph: speed,
          color: defaultActorColor({ kind: recipe.kind }),
          timed_waypoints: walker.waypoints.map((w) => ({ x: w.x, y: w.y, time: w.time })),
          sensors: [],
        };
        actors.push(authorGeneratedActor(actor));
        continue;
      }
      // Planner returned a result but this specific role didn't get a
      // plan (e.g. walker role with no walker plan). Fall through to the
      // heuristic build for this actor only.
    }

    // ── Heuristic fallback ────────────────────────────────────────────
    const placement = rolePlacements[recipe.role]!;
    const placementMode: "road" | "point" | "timed_path" =
      placement.kind === "lane"
        ? "road"
        : placement.kind === "timed_path"
          ? "timed_path"
          : "point";
    // The schema requires `spawn` (road anchor) even for non-road
    // placements; the runtime ignores it then. We use the subject's lane
    // as a benign placeholder when present so any code path that does
    // read `spawn.road_id` still sees a coherent value.
    const fallbackLane = placement.kind === "lane" ? placement.lane : subjectAnchor;
    const spawnPoint =
      placement.kind === "point"
        ? placement.point
        : placement.kind === "timed_path"
          ? placement.spawnPoint
          : null;
    const timedWaypoints =
      placement.kind === "timed_path"
        ? placement.waypoints.map((w) => ({ x: w.x, y: w.y, time: w.time }))
        : undefined;
    // Apply NPC vehicle-type override on the heuristic fallback path
    // too, so cyclist / motorcycle still works when the planner
    // degraded.
    const fallbackBlueprint =
      recipe.role !== "subject" && npcOverride
        ? npcOverride.blueprint
        : recipe.blueprint;
    const actor: ScenarioEditorActorDraft = {
      id,
      label: buildActorLabel(
        {
          kind: recipe.kind,
          role: recipe.scenarioRole,
          placement_mode: placementMode,
          is_static: false,
          blueprint: fallbackBlueprint,
        },
        actors,
      ),
      kind: recipe.kind,
      role: recipe.scenarioRole,
      is_static: false,
      placement_mode: placementMode,
      blueprint: fallbackBlueprint,
      spawn: fallbackLane
        ? buildRoadAnchor(
            fallbackLane,
            placement.kind === "lane" ? placement.s_fraction : undefined,
          )
        : emptyNonRoadSpawnAnchor(),
      spawn_point: spawnPoint,
      spawn_yaw: undefined,
      route: [],
      route_direction: "forward",
      lane_facing: "with_lane",
      destination: null,
      // Pin the subject's `destination_point` for the pedestrian_crossing
      // family so CARLA's traffic manager routes through the crossing
      // rather than turning off at a junction before reaching it.
      // All other actors (and other families) keep destination_point=null.
      destination_point:
        recipe.role === "subject" && subjectPedestrianDestination
          ? subjectPedestrianDestination
          : null,
      speed_kph: speed,
      color: defaultActorColor({ kind: recipe.kind }),
      ...(timedWaypoints ? { timed_waypoints: timedWaypoints } : {}),
      sensors: defaultActorSensors(recipe.role === "subject"),
    };
    // A timed-path placement is its own spec, whatever the recipe says: the
    // baseline follows the trajectory and the recipe's clips are dropped.
    // Otherwise the recipe names the baseline — the Traffic Manager, or our
    // controller cruising at the resolved speed — and its clips fire on top.
    const baseAction: BehaviorAction | undefined =
      placement.kind === "timed_path" || recipe.baseline === "placement"
        ? undefined
        : recipe.baseline === "autopilot"
          ? { kind: "autopilot", enabled: true }
          : { kind: "cruise", speed_kph: speed };
    actors.push(
      authorGeneratedActor(actor, {
        ...(baseAction ? { base: { action: baseAction } } : {}),
        interactions:
          placement.kind === "timed_path"
            ? []
            : resolveInteractionClips(recipe, aggressiveness, roleIdMap),
      }),
    );
  }
  return actors;
}
