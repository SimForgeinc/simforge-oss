/**
 * Populated-draft factory for the AI Search collision flow.
 *
 * The legacy `propose_scenario_draft` path (see `draft-generator.ts`) creates
 * a draft anchored to a map location but with only a single random-segment
 * subject — the user opens the editor and has to assemble the actual collision
 * scenario by hand. This builder replaces that one-shot seed with a
 * family-aware composition:
 *
 *   - Look up the `COLLISION_TEMPLATES` entry for the chosen family.
 *   - Anchor each actor in `actorRecipe` to a real lane from the geometry
 *     report (already collected by `inspect_location_geometry`).
 *   - Hydrate timeline clips with role-resolved speeds and target ids.
 *   - Lower the assembled draft actors to the map-bound scenario template the
 *     native runtime executes, accept it on a real native run, and persist
 *     that same template as a scenario document that opens in the editor.
 */
import "server-only";
import {
  COLLISION_TEMPLATES,
  FAMILY_ESMINI_OUTCOME,
  TARGET_COLLISION_TIME_S,
  applyAggressivenessToSpeedKph,
  parseAggressivenessLabel,
  plannedSubjectActor,
  type CollisionActorRole,
  type CollisionFamilyId,
  type CollisionRequiredGeometry,
  type NpcAggressiveness,
  type ScenarioValidationReport,
} from "@simforge-oss/studio-shared";
import type { AppContext } from "@/app/lib/db/app-context";
import {
  DEFAULT_SCENARIO_AUTHORING_QUALITY_ID,
  SCENARIO_SCHEMA_VERSION,
} from "@/app/lib/scenario/contracts";
import {
  CollisionDraftMapUnavailableError,
  loadCollisionDraftMap,
} from "@/app/lib/scenario/collision-draft-map.server";
import {
  lowerCollisionDraftCandidate,
  type CollisionDraftMapBinding,
} from "@simforge-oss/studio-host/node";
import { ensureDefaultScenarioDataset } from "@/app/lib/scenario/dataset-store";
import { createScenarioDocument } from "@/app/lib/scenario/document-store";
import { buildDashboardEditorHref } from "@/app/lib/scenario/routes";
import { ScenarioDraftBridgeError } from "@/app/lib/scenario-editor/draft-generator";
import type { GeometryLaneSample, GeometryReport } from "@/app/lib/maps/search/server/inspect-location-geometry";
import type { PlanCollisionRoutesResult } from "@/app/lib/llm/scenario-generation/collision-route-planner";
import { validateCollisionDraft } from "@/app/lib/llm/scenario-generation/validation/draft-validator";
import { solvePedestrianCrossingTiming } from "@/app/lib/llm/scenario-generation/validation/pedestrian-timing-solver";
import {
  buildPedPlannerTrace,
  logPlannerTrace,
  type PlannerTrace,
} from "@/app/lib/llm/scenario-generation/planner/planner-trace";
import { snapDraftActorsToRuntimeRoads } from "@/app/lib/llm/scenario-generation/runtime-road-snap";
import {
  computeSubjectDestinationForPedestrianCrossing,
  computePedestrianCrossing,
  laneKey,
  resolveAnchor,
  type ActorPlacement,
} from "@/app/lib/llm/scenario-generation/collision-anchor-resolution";
import { buildCollisionDraftActors } from "@/app/lib/llm/scenario-generation/collision-actor-assembly";
import { planCollisionScenarioDraft } from "@/app/lib/llm/scenario-generation/collision-planning";
import { stampCollisionGeneratedOutput } from "@/app/lib/scenario-generation/scenario-intention";

export {
  computePedestrianCrossing,
  resolveAnchor,
  type ActorPlacement,
} from "@/app/lib/llm/scenario-generation/collision-anchor-resolution";
export { defaultActorSensors } from "@/app/lib/llm/scenario-generation/collision-actor-assembly";

const MAX_DISPLAY_NAME_LENGTH = 80;
/** Generator identity stamped on intention metadata and the document's `appVersion`. */
const COLLISION_GENERATOR = "simforge.collision_scenario_builder.v2";
/** Document extension carrying the generator's provenance, intention and metadata. */
const COLLISION_GENERATOR_EXTENSION = "simforge.collision-generator";

// Spawn heading is derived from the planned path's first segment via
// `spawnYawDegFromPlannedPath` (collision-route-planner). The former
// `frontendYawRadToScenarioSpawnYawDeg` applied a blanket +180° to the
// lane reference-line yaw, which spawned half of all scenarios reversed
// (lane-id sign / bidirectional lanes) — removed.

export interface CollisionDraftMapAsset {
  map_asset_id: string;
  name: string;
}

export interface BuildCollisionScenarioDraftArgs {
  context: AppContext;
  mapAsset: CollisionDraftMapAsset;
  documentId: string;
  documentLabel: string;
  candidateId?: string | null;
  family: CollisionFamilyId;
  intent: string;
  /** Optional override; falls back to the template default. */
  aggressivenessLabel?: string | null;
  /** Override the NPC vehicle blueprint + base speed when the user
   *  wanted a cyclist or motorcyclist rather than a car. Applies only to
   *  vehicle-NPC families (`unprotected_left_turn`, `unsafe_cut_in`);
   *  the walker recipe in `pedestrian_crossing` is unaffected. */
  npcVehicleType?: "car" | "bicycle" | "motorcycle" | null;
  /** Geometry report from `inspect_location_geometry` for the target document. */
  geometry: GeometryReport;
  /** Geometry reports for streets that lead INTO the target document (from
   *  the LLM running `search_map` with `relation.op = 'upstream_of'`).
   *  Empty when the LLM didn't run the upstream-of query — the builder
   *  then falls back to the target's euclidean-nearby lanes for subject. */
  approachGeometries?: readonly GeometryReport[];
}

/**
 * Blueprint + realistic base speed (kph) for each `npcVehicleType`. Bicycle /
 * motorcycle keep kind "vehicle" so the rest of the actor schema works
 * unchanged; the lowering resolves each blueprint to its catalog model.
 */
const NPC_VEHICLE_OVERRIDES: Record<
  "car" | "bicycle" | "motorcycle",
  { blueprint: string; baseSpeedKph: number } | null
> = {
  car: null,
  bicycle: { blueprint: "vehicle.bicycle", baseSpeedKph: 18 },
  motorcycle: { blueprint: "vehicle.motorcycle", baseSpeedKph: 60 },
};

export interface CollisionScenarioDraftResult {
  /** The persisted scenario document id. */
  scenarioId: string;
  datasetId: string;
  mapAssetId: string;
  documentId: string;
  candidateId: string | null;
  displayName: string;
  editorHref: string;
  /** Family the builder instantiated. Surfaced for client display. */
  family: CollisionFamilyId;
  /** Resolved aggressiveness — useful for analytics + display chips. */
  aggressiveness: NpcAggressiveness;
  /** Number of actors the builder placed. Always ≥ 2 on success. */
  actorCount: number;
  /** Multi-line markdown the AI Search panel renders inside the
   *  draft-created card so the user can see what the LLM committed to
   *  without opening the editor. Mirrors the draft's `metadata.notes`. */
  description: string;
  /** Native validation of the persisted candidate (engine
   *  `simforge-native`) with the Tier-1 auto-repair record attached. The
   *  agent uses `verdict`/`reasons` to decide whether to revise; the
   *  panel renders a pass/fail badge from it. */
  validation: ScenarioValidationReport;
  /** Structured trace of the deterministic pedestrian-crossing topology
   *  planner (site selection + subject back-walk + walker timing + validator
   *  verdict). Populated only when the topology ped planner produced the
   *  draft; null on the heuristic ped fallback and for every non-ped
   *  family. Surfaced for logs / observability. */
  plannerDebug?: PlannerTrace | null;
}

function buildNotesBlock(
  family: CollisionFamilyId,
  aggressiveness: NpcAggressiveness,
  intent: string,
  documentLabel: string,
  plannerResult: PlanCollisionRoutesResult | null,
  plannerError: string | null,
  npcVehicleType: "car" | "bicycle" | "motorcycle" | null,
): string {
  // Emitted as markdown — the AI Search panel renders this verbatim
  // inside the draft-created card via the same ReactMarkdown pipeline as
  // assistant replies, so bold labels + bullet structure come through. It
  // is also the persisted document's description.
  const template = COLLISION_TEMPLATES[family];
  const env = template.defaultEnvironment;
  const envLabel = `${env.lighting.toLowerCase()}, ${env.weather.toLowerCase().replace(/_/g, " ")}, ${env.roadSurface.toLowerCase().replace(/_/g, " ")}`;
  const lines: string[] = [
    `**Intent:** ${intent.trim()}`,
    "",
    `- **Family:** ${template.label}`,
    `- **Location:** ${documentLabel}`,
    `- **NPC aggressiveness:** ${aggressiveness}`,
    `- **Environment:** ${envLabel}`,
    `- **Success condition:** ${template.successCondition}`,
  ];
  if (npcVehicleType && npcVehicleType !== "car") {
    lines.splice(4, 0, `- **NPC vehicle type:** ${npcVehicleType}`);
  }
  if (plannerResult) {
    lines.push(`- **Planner:** ${plannerResult.collision.rationale}`);
  } else if (plannerError) {
    lines.push(`- **Planner:** degraded — used heuristic placement (${plannerError})`);
  }
  return lines.join("\n");
}

function trimDisplayName(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length <= MAX_DISPLAY_NAME_LENGTH) return collapsed;
  return `${collapsed.slice(0, MAX_DISPLAY_NAME_LENGTH - 1).trimEnd()}…`;
}

function composeDisplayName(
  family: CollisionFamilyId,
  intent: string,
  documentLabel: string,
): string {
  const template = COLLISION_TEMPLATES[family];
  const intentTrim = intent.trim();
  const headline = intentTrim.length > 0 ? intentTrim : template.label;
  return trimDisplayName(`AI: ${headline} @ ${documentLabel}`);
}

// ── Family ↔ geometry compatibility ─────────────────────────────────────────

/**
 * Enforce the family's `requiredGeometry` predicate against the inspected
 * document BEFORE composing any actors. Without this a request like a
 * `pedestrian_crossing` family on a doc with no pedestrian/crosswalk tags
 * would still produce a draft whenever lane anchors happened to resolve —
 * exactly the misleading-draft case the inspect-then-propose contract is
 * meant to prevent. Throws `ScenarioDraftBridgeError("family_geometry_mismatch")`
 * so the LLM service surfaces an actionable tool error and the model can
 * pick a different family or location.
 *
 * Two independent gates (both must pass):
 *   1. `documentFamilies` — the doc's object family must be in the allowed
 *      set (OR over the list).
 *   2. `requireTagAnyOf` — when non-null, at least one substring must appear
 *      (case-insensitive) in the document's scenarioTags ∪ facts ∪ subtype.
 *      For `pedestrian_crossing` the canonical `pedestrianSpawn` boolean is
 *      an accepted alternative: the enrichment pipeline already collapses
 *      every pedestrian-bearing location kind into that flag, and the
 *      humanized tag text doesn't always echo the raw substrings.
 */
/** @internal Exported for unit tests; production callers reach this via
 *  `buildCollisionScenarioDraft`, not directly. */
export function assertFamilyGeometry(
  family: CollisionFamilyId,
  required: CollisionRequiredGeometry,
  geometry: GeometryReport,
): void {
  if (!required.documentFamilies.includes(geometry.documentFamily)) {
    throw new ScenarioDraftBridgeError(
      "family_geometry_mismatch",
      `A ${COLLISION_TEMPLATES[family].label} scenario needs a ${required.documentFamilies.join(" or ")} document, but "${geometry.documentLabel}" is a ${geometry.documentFamily}. Pick a ${required.documentFamilies.join("/")} location for this family.`,
    );
  }

  if (required.requireTagAnyOf != null) {
    const haystack = [
      geometry.documentSubtype,
      ...geometry.scenarioTags,
      ...geometry.facts,
    ]
      .join(" | ")
      .toLowerCase();
    const tagMatch = required.requireTagAnyOf.some((needle) =>
      haystack.includes(needle.toLowerCase()),
    );
    const pedestrianOk =
      family === "pedestrian_crossing" && geometry.pedestrianSpawn;
    if (!tagMatch && !pedestrianOk) {
      throw new ScenarioDraftBridgeError(
        "family_geometry_mismatch",
        `"${geometry.documentLabel}" doesn't have the tags a ${COLLISION_TEMPLATES[family].label} scenario needs (one of: ${required.requireTagAnyOf.join(", ")}). Pick a location whose tags support this family, or choose a different family.`,
      );
    }
  }
}

// ── Entry point ─────────────────────────────────────────────────────────────

/**
 * Build a populated scenario draft from a collision family + geometry report.
 *
 * Throws `ScenarioDraftBridgeError` for caller-actionable failures
 * (`map_unavailable`, `geometry_insufficient`, `family_geometry_mismatch`)
 * so the LLM service can surface a tool-error message to the user. Other
 * failures bubble unchanged.
 */
export async function buildCollisionScenarioDraft(
  args: BuildCollisionScenarioDraftArgs,
): Promise<CollisionScenarioDraftResult> {
  if (!args.geometry.centerResolved || args.geometry.availableLanes.length === 0) {
    throw new ScenarioDraftBridgeError(
      "geometry_insufficient",
      "The chosen location has no nearby drivable lanes to anchor actors. Pick a junction or street within the map's road network.",
    );
  }

  // The immutable map the candidate is planned on, executed on and saved
  // against. No published map version means nothing can execute the draft.
  let map: CollisionDraftMapBinding;
  try {
    map = await loadCollisionDraftMap(args.context, args.mapAsset.map_asset_id);
  } catch (err) {
    if (err instanceof CollisionDraftMapUnavailableError) {
      throw new ScenarioDraftBridgeError("map_unavailable", err.message);
    }
    throw err;
  }

  const template = COLLISION_TEMPLATES[args.family];

  // Enforce family ↔ document compatibility before composing any actors.
  // Lane anchors can resolve on the wrong kind of location (e.g. a parking
  // lot has drivable lanes too); this gate is what keeps an incompatible
  // family selection from silently producing a misleading draft.
  assertFamilyGeometry(args.family, template.requiredGeometry, args.geometry);

  const aggressiveness = parseAggressivenessLabel(args.aggressivenessLabel);

  // ── Planner happy-path ────────────────────────────────────────────────
  //
  // Try the deterministic backward-planner first. It returns concrete
  // spawn points + waypoint polylines so subject + NPC converge at a planned
  // conflict point. When it succeeds, every actor uses `timed_path` with
  // autopilot OFF: the authored schedule the native runtime executes.
  //
  // On null return (geometry too sparse, no opposing lane, etc.) we fall
  // through to the legacy heuristic placement below and surface the
  // failure mode in the draft's notes.
  const subjectRecipe = template.actorRecipe.find((r) => r.role === "subject");
  const npcRecipe = template.actorRecipe.find((r) => r.role !== "subject");
  const approachGeometries = args.approachGeometries ?? [];
  // NPC vehicle-type override. Only applies when the NPC recipe is a
  // vehicle (cyclist / motorcycle don't apply to walker recipes).
  const npcOverride =
    args.npcVehicleType && npcRecipe?.kind === "vehicle"
      ? NPC_VEHICLE_OVERRIDES[args.npcVehicleType]
      : null;
  const subjectSpeedKph =
    subjectRecipe?.aggressivenessAppliesTo === "speed"
      ? applyAggressivenessToSpeedKph(subjectRecipe.baseSpeedKph, aggressiveness)
      : (subjectRecipe?.baseSpeedKph ?? 40);
  const npcBaseSpeed = npcOverride?.baseSpeedKph ?? npcRecipe?.baseSpeedKph ?? 40;
  const npcSpeedKph =
    npcRecipe?.aggressivenessAppliesTo === "speed"
      ? applyAggressivenessToSpeedKph(npcBaseSpeed, aggressiveness)
      : npcBaseSpeed;
  const planning = await planCollisionScenarioDraft({
    family: args.family,
    mapAssetId: args.mapAsset.map_asset_id,
    map,
    geometry: args.geometry,
    approachGeometries,
    template,
    subjectSpeedKph,
    npcSpeedKph,
    npcVehicleType: args.npcVehicleType ?? null,
  });
  const { intendedLocation, plannerResult, plannerError, pedTopo } = planning;
  let { repairAttempts, repairSucceeded } = planning;
  const { repairStrategies, acceptWin, runtimeRoadSegments, pedRepick } = planning;
  let plannerTrace: PlannerTrace | null = null;

  // Resolve placements in recipe order so subject anchors first and subsequent
  // roles can reference it for opposite/adjacent picks. Used by the
  // fallback heuristic path when the planner couldn't synthesize routes.
  // When `plannerResult` is non-null we skip this — the planner already
  // produced spawn points + waypoint polylines for every actor — and any
  // heuristic failure here would mask a successful plan.
  const used = new Set<string>();
  const rolePlacements: Partial<Record<CollisionActorRole, ActorPlacement>> = {};
  let subjectAnchor: GeometryLaneSample | null = null;
  if (!plannerResult) {
    for (const recipe of template.actorRecipe) {
      const placement = resolveAnchor(
        recipe.anchorStrategy,
        args.geometry,
        subjectAnchor,
        used,
        approachGeometries,
      );
      if (!placement) {
        throw new ScenarioDraftBridgeError(
          "geometry_insufficient",
          `Could not find a ${recipe.anchorStrategy.replace(/_/g, " ")} lane near "${args.geometry.documentLabel}" for role '${recipe.role}'.`,
        );
      }
      if (placement.kind === "lane") used.add(laneKey(placement.lane));
      if (recipe.kind === "walker") {
        const crossing = computePedestrianCrossing(args.geometry, subjectAnchor);
        if (crossing) rolePlacements[recipe.role] = crossing;
        else rolePlacements[recipe.role] = placement;
      } else {
        rolePlacements[recipe.role] = placement;
      }
      if (recipe.role === "subject" && placement.kind === "lane") subjectAnchor = placement.lane;
    }
  }

  // Pre-assign ids per role so timeline clips can target by role.
  const roleIdMap: Record<string, string> = {};
  for (const recipe of template.actorRecipe) {
    roleIdMap[recipe.role] = crypto.randomUUID();
  }

  // Family-scoped: for pedestrian_crossing on the heuristic fallback path,
  // subject needs a `destination_point` so autopilot routes through the
  // crossing instead of picking a heuristic turn at the first junction.
  // The planner path doesn't need this — it emits explicit waypoints
  // through the conflict point.
  const subjectPedestrianDestination =
    !plannerResult && args.family === "pedestrian_crossing"
      ? computeSubjectDestinationForPedestrianCrossing(args.geometry, subjectAnchor)
      : null;

  // Build actor drafts. Two code paths:
  //
  // Planner happy-path uses the planner's timed-path geometry with autopilot
  // OFF. Heuristic fallback uses the role placements computed above.
  const actors = buildCollisionDraftActors({
    template,
    plannerResult,
    rolePlacements,
    roleIdMap,
    npcOverride,
    aggressiveness,
    subjectAnchor,
    subjectPedestrianDestination,
  });

  // ── Execution road-network snap ───────────────────────────────────────
  //
  // Project every emitted spawn / path waypoint / destination onto the map's
  // accepted semantic execution road network. The Tier-0 planner sources
  // gate geometry from the XODR topology index and the heuristic /
  // pedestrian paths project points euclidean-ly; neither is guaranteed to
  // coincide with an executable lane, so without this pass actors can land
  // off the drivable network. Snapping happens BEFORE the authoritative
  // validation below so the native run (and any Tier-2 repair) executes the
  // on-road geometry. Throws `ScenarioDraftBridgeError("location_off_runtime_road")`
  // when a required point is implausibly far from any lane — the LLM
  // service surfaces that so the agent re-picks the location.
  // `runtimeRoadSegments` were read once above (the pedestrian-crossing
  // re-pick probe reuses the same snap), so we don't re-fetch them here.
  const snapSummary = snapDraftActorsToRuntimeRoads(actors, runtimeRoadSegments);

  const dataset = await ensureDefaultScenarioDataset(args.context);

  const displayName = composeDisplayName(args.family, args.intent, args.documentLabel);
  const baseNotes = buildNotesBlock(
    args.family,
    aggressiveness,
    args.intent,
    args.documentLabel,
    plannerResult,
    plannerError,
    args.npcVehicleType ?? null,
  );
  const notes =
    snapSummary.pointsSnapped > 0
      ? `${baseNotes}\n- **Road snap:** moved ${snapSummary.pointsSnapped} point(s) across ${snapSummary.snappedActorCount} actor(s) onto execution lanes (max ${snapSummary.maxSnapDistanceM}m).`
      : baseNotes;

  const geometryContext = [
    args.geometry.documentSubtype,
    ...args.geometry.scenarioTags,
  ].join(" ");
  const subjectActorId = plannedSubjectActor(actors)?.id ?? null;
  const stamp = () =>
    stampCollisionGeneratedOutput({
      generator: COLLISION_GENERATOR,
      seed: 0,
      family: args.family,
      actors,
      principalActorIds: new Set(
        actors
          .filter((actor) => actor.id !== subjectActorId)
          .map((actor) => actor.id),
      ),
      plannedOutcome: FAMILY_ESMINI_OUTCOME[args.family],
      npcVehicleType: args.npcVehicleType ?? null,
      weather: `${template.defaultEnvironment.weather} ${template.defaultEnvironment.roadSurface}`,
      environmentPreset: template.defaultEnvironment,
      occlusionSubtype: /occlu|bus stop|parking|delivery/i.test(geometryContext)
        ? geometryContext
        : null,
      signalized: /signalized|traffic light/i.test(geometryContext),
      contextHint:
        args.family === "pedestrian_crossing" &&
        /mid.?block|non.?junction/i.test(geometryContext)
          ? "mid_block"
          : undefined,
    });

  // The authored candidate: the map-bound template these draft actors lower
  // to. It is what the native runtime executes for the verdict below and,
  // unchanged, what is saved — so the validation and the document agree.
  const lower = () => {
    const stamped = stamp();
    const lowered = lowerCollisionDraftCandidate({
      name: displayName,
      appVersion: COLLISION_GENERATOR,
      actors: stamped.actors,
      map,
      durationS: template.durationSeconds,
      environmentPreset: template.defaultEnvironment,
      notes,
      scenarioIntention: stamped.scenarioIntention,
      extensions: {
        [COLLISION_GENERATOR_EXTENSION]: {
          generator: COLLISION_GENERATOR,
          family: args.family,
          scenarioIntention: stamped.scenarioIntention,
          scenarioMetadata: stamped.scenarioMetadata,
          plannedOutcome: FAMILY_ESMINI_OUTCOME[args.family],
        },
      },
    });
    return { lowered, outcome: stamped.scenarioIntention.outcome };
  };
  let { lowered, outcome } = lower();

  // Authoritative validation on the ACTUAL assembled candidate (the document
  // that will be persisted), not the in-loop proxy, judged against the
  // outcome its stamped scenario intention authors. Carries the Tier-1
  // auto-repair record so the agent + panel can show what was tried.
  //
  // Pedestrian-crossing carries an absolute accept window so the
  // `collision_occurred` check accepts any contact in `[min,max]` (instead
  // of the relative ±tolerance) — the planner solves the walker hold to the
  // template ideal, but joint-gap arc-length and road snapping shift the
  // real contact a second or two either way, all of which is a legitimate
  // ped crossing. Other families leave this undefined (legacy behavior).
  const acceptWindowS =
    args.family === "pedestrian_crossing" ? acceptWin : undefined;
  const conflictHint = plannerResult
    ? {
        conflictPoint: plannerResult.collision.conflictPoint,
        arrivalTimeS: plannerResult.collision.arrivalTimeS,
        subjectTurnRelation: plannerResult.collision.subjectGate?.turnRelation ?? null,
        acceptWindowS,
      }
    : null;
  let validation: ScenarioValidationReport = validateCollisionDraft({
    family: args.family,
    outcome,
    actors,
    map,
    environmentPreset: template.defaultEnvironment,
    lowered,
    intendedLocation,
    conflict: conflictHint,
    durationS: template.durationSeconds,
  });

  // ── Tier-2 deterministic auto-repair: pedestrian-crossing timing solve ──
  //
  // Tier-1 only tunes subject/NPC *speed* through the planner — it never
  // re-times the walker, so a pedestrian_crossing that misses purely on
  // timing (subject reaches the crossing a fraction of a second off the
  // walker's hardcoded step-off) survives the whole speed grid. Re-time
  // the walker so it reaches the crossing centre exactly when the subject
  // does, then re-execute. We adopt the re-timed walker ONLY if the
  // authoritative native report flips to pass — the solver bails (null) on
  // geometry/region misses, which then fall through to the LLM revise
  // loop instead of being papered over. Repaired drafts pass but are
  // flagged for review since the timing was machine-derived.
  let tier2Repaired = false;
  if (
    args.family === "pedestrian_crossing" &&
    validation.verdict === "fail" &&
    !validation.collision.occurred
  ) {
    const subjectActor = plannedSubjectActor(actors);
    const walkerActor = actors.find((a) => a.kind === "walker");
    if (subjectActor && walkerActor) {
      const solved = solvePedestrianCrossingTiming({
        subject: subjectActor,
        walker: walkerActor,
        durationS: template.durationSeconds,
      });
      if (solved) {
        const previousWaypoints = walkerActor.timed_waypoints;
        walkerActor.timed_waypoints = solved.waypoints;
        const relowered = lower();
        const reprobe = validateCollisionDraft({
          family: args.family,
          outcome: relowered.outcome,
          actors,
          map,
          environmentPreset: template.defaultEnvironment,
          lowered: relowered.lowered,
          intendedLocation,
          conflict: conflictHint,
          durationS: template.durationSeconds,
        });
        if (reprobe.verdict === "pass") {
          validation = reprobe;
          ({ lowered, outcome } = relowered);
          tier2Repaired = true;
          repairStrategies.push(
            `tier2: pedestrian timing solve (hold ${solved.previousHoldS.toFixed(
              1,
            )}s→${solved.holdS.toFixed(1)}s)`,
          );
          repairAttempts += 1;
          repairSucceeded = true;
        } else {
          // Re-timing didn't fix it (e.g. region miss). Revert so the
          // persisted document + report stay consistent with the failure
          // we surface to the agent.
          walkerActor.timed_waypoints = previousWaypoints;
        }
      }
    }
  }

  const repairRecord = {
    attempted: true,
    attempts: repairAttempts,
    succeeded: repairSucceeded,
    strategies: repairStrategies,
  };
  validation.repair = repairRecord;

  // ── Pedestrian-crossing planner trace (logs / observability) ──────────
  //
  // When the deterministic topology planner produced the draft, stamp its
  // own trace (site selection + subject back-walk + walker timing) with the
  // AUTHORITATIVE post-repair verdict + observed contact time, log it, and
  // thread it onto the result. Null on the heuristic ped fallback (topology
  // returned null) and for every non-ped family.
  if (pedTopo && template.collisionTimeWindow) {
    plannerTrace = buildPedPlannerTrace(
      pedTopo,
      {
        result: validation.verdict,
        contactS: validation.collision.timeS,
      },
      {
        min: template.collisionTimeWindow.min,
        max: template.collisionTimeWindow.max,
      },
      pedRepick ?? undefined,
    );
    logPlannerTrace(plannerTrace);
  }
  const repairedNote =
    validation.repair.succeeded && validation.repair.strategies.length > 0
      ? ` (auto-repaired: ${validation.repair.strategies.join(", ")})`
      : "";
  // Surfacing: a draft fixed by Tier-2 passes validation but the timing
  // was machine-derived — flag it so the user sanity-checks it in the
  // editor rather than trusting it blindly.
  const reviewFlag = tier2Repaired ? " — review timing in editor" : "";
  const notesWithValidation =
    validation.verdict === "pass"
      ? `${notes}\n\n- **Validation (${validation.engine}):** PASS${repairedNote}${reviewFlag}`
      : `${notes}\n\n- **Validation (${validation.engine}):** FAIL — ${
          validation.reasons[0] ?? "see report"
        }`;

  // Persist the validated candidate as a scenario document: the same
  // template the native runtime just executed, described for the panel.
  const document = await createScenarioDocument(args.context, {
    title: displayName,
    description: notesWithValidation,
    schemaVersion: SCENARIO_SCHEMA_VERSION,
    content: lowered.template,
    mapVersionId: map.mapVersionId,
    datasetId: dataset.id,
    authoringQualityId: DEFAULT_SCENARIO_AUTHORING_QUALITY_ID,
  });

  // Relative by default (resolves against whatever origin serves the link).
  // Optional override: when running locally against a deployed-env S3
  // bucket, set SCENARIO_EDITOR_BASE_URL in the local environment to the
  // deployed origin so generated drafts open there instead of localhost
  // (a localhost origin would direct-fetch cross-origin S3 and CORS-fail
  // on artifact loads). Unset in deployed environments → unchanged.
  const relativeEditorHref = buildDashboardEditorHref({
    datasetId: dataset.id,
    documentId: document.id,
  });
  const editorBaseUrl = process.env.SCENARIO_EDITOR_BASE_URL?.trim();
  let editorHref = relativeEditorHref;
  if (editorBaseUrl) {
    try {
      editorHref = new URL(
        relativeEditorHref,
        editorBaseUrl.replace(/\/$/, ""),
      ).toString();
    } catch {
      editorHref = relativeEditorHref;
    }
  }

  return {
    scenarioId: document.id,
    datasetId: dataset.id,
    mapAssetId: args.mapAsset.map_asset_id,
    documentId: args.documentId,
    candidateId: args.candidateId ?? null,
    displayName,
    editorHref,
    family: args.family,
    aggressiveness,
    actorCount: actors.length,
    description: notesWithValidation,
    validation,
    plannerDebug: plannerTrace,
  };
}
