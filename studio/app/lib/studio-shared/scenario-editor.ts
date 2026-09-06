import { z } from "zod";
import {
  ActorBehaviorProgramSchema,
  ReactionProfileSchema,
  SIMULATION_DEFAULTS,
  SensorSchema,
  TrafficAggressiveness,
  TrafficCardSchema,
  TrafficDensity,
  TrafficManagerSchema,
  VehicleMixPreset,
  type BehaviorRoadAnchor,
  type BehaviorWaypoint,
} from "@simforge-oss/scenario/contracts";
import { SemanticActorAuthoringSchema } from "./semantic-actor-authoring";
import { SceneFormationSchema, SceneFormationSolutionSchema } from "./scene-formation";
import {
  ActorBehaviorMetadataSchema,
  ScenarioIntentionSchema,
} from "./scenario-intention";
import { ScenarioMetadataSchema } from "./scenario-metadata";
import { JunctionSignalPlanSchema } from "./scenario-signals";

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
   * must not infer placement from a legacy road id after runtime-exact semantic
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

export const ScenarioEditorMapPointSchema = z.object({
  x: z.number(),
  y: z.number(),
  /** Optional intended elevation (world meters). When set, the worker resolves a
   * POINT/timed_path spawn to the ground surface NEAREST this z — disambiguating
   * maps with stacked/overlapping geometry (otherwise a point actor snaps to the
   * topmost surface and floats; the "pedestrian dropped from the sky"). Omit on
   * flat maps to keep the topmost-surface behavior. */
  z: z.number().optional(),
});
export type ScenarioEditorMapPoint = z.infer<typeof ScenarioEditorMapPointSchema>;

export const ScenarioEditorPathSegmentDirectionSchema = z.enum(["forward", "reverse"]);
export type ScenarioEditorPathSegmentDirection = z.infer<
  typeof ScenarioEditorPathSegmentDirectionSchema
>;

export const ScenarioEditorTimedWaypointSchema = ScenarioEditorMapPointSchema.extend({
  /**
   * How this is read depends on the actor's `path_timing`.
   *
   * Under `"ordering"` (the default, and every draft written before 2026-07-25)
   * it orders the polyline and nothing more — vehicles follow it with
   * arc-length pure pursuit at `speed_kph`, and movement is not
   * time-interpolated. Under `"schedule"` it is an arrival time the runtime
   * drives the vehicle to hit. Walkers have always read it as a schedule.
   */
  time: z.number().min(0),
  /** Controls the segment from the previous path point to this waypoint. Ignored under `path_timing: "schedule"`, where spacing is the speed. */
  speed_kph: z.number().min(0).nullable().optional(),
  /** Controls the segment from the previous path point to this waypoint. */
  direction: ScenarioEditorPathSegmentDirectionSchema.optional(),
  /** Placement provenance, for re-snapping on drag and for the marker style.
   *  Absent = "free". Storage stays a WORLD point either way — the world_anchor
   *  doctrine (xosc-writer/geometry.ts:1-17) forbids persisting road ids, which
   *  UE5 renumbers across map rebuilds. */
  snap: z.enum(["lane", "free"]).optional(),
});
export type ScenarioEditorTimedWaypoint = z.infer<typeof ScenarioEditorTimedWaypointSchema>;

type Assert<T extends true> = T;
type Extends<A, B> = A extends B ? true : false;

// Compile-time proof the shared behavior program's structural twins stay
// interchangeable with the editor's own anchor and waypoint shapes.
export type _BehaviorAnchorAcceptsEditorAnchor = Assert<
  Extends<ScenarioEditorRoadAnchor, BehaviorRoadAnchor>
>;
export type _EditorAnchorAcceptsBehaviorAnchor = Assert<
  Extends<BehaviorRoadAnchor, ScenarioEditorRoadAnchor>
>;
export type _BehaviorWaypointAcceptsEditorWaypoint = Assert<
  Extends<ScenarioEditorTimedWaypoint, BehaviorWaypoint>
>;

/**
 * PARKING MANEUVER contract (emit ⇄ worker). A precise, cusped, gear-aware
 * REAR-AXLE trajectory into a mapped parking bay, planned at emit time by the
 * parking-maneuver core (`planner/parking`). Waypoints are rear-axle poses in
 * the runtime frontend frame (x, y = CARLA x, −y; yaw_deg = frontend yaw); the
 * worker converts rear-axle→actor as needed. Segments run IN ORDER, each a
 * CONSTANT gear; a cusp is the boundary between two segments (ego stops, holds,
 * flips gear). Speeds: ≤1.5 fwd / ≤0.8 rev, ≤0.35 within ~2 m of the goal.
 */
export const ParkingManeuverWaypointSchema = z.object({
  x: z.number(),
  y: z.number(),
  yaw_deg: z.number(),
  speed_mps: z.number().min(0),
});
export type ParkingManeuverWaypoint = z.infer<typeof ParkingManeuverWaypointSchema>;

export const ParkingManeuverSegmentSchema = z.object({
  gear: z.enum(["forward", "reverse"]),
  /** ≥2: a segment is a constant-gear TRAJECTORY, and the worker's
   * `parse_parking_maneuver` rejects a single-waypoint segment as
   * `degenerate_segment` (→ `parking.parse_failed`, ego held in place). The
   * schema minimum matches the executor contract so a scenario that validates
   * here cannot be a guaranteed runtime failure. */
  waypoints: z.array(ParkingManeuverWaypointSchema).min(2),
});
export type ParkingManeuverSegment = z.infer<typeof ParkingManeuverSegmentSchema>;

export const ParkingManeuverSchema = z.object({
  frame: z.literal("rear_axle"),
  vehicle: z.object({
    wheelbase_m: z.number().positive(),
    front_overhang_m: z.number().min(0),
    rear_overhang_m: z.number().min(0),
    half_width_m: z.number().positive(),
  }),
  segments: z.array(ParkingManeuverSegmentSchema).min(1),
  terminal: z.object({
    x: z.number(),
    y: z.number(),
    yaw_deg: z.number(),
    hold_s: z.number().min(0),
    clearance_m: z.number(),
    bay_id: z.union([z.string(), z.number()]),
  }),
});
export type ParkingManeuver = z.infer<typeof ParkingManeuverSchema>;

export const ScenarioEditorActorPlacementModeSchema = z.enum([
  "road",
  "path",
  "point",
  "timed_path",
]);
export type ScenarioEditorActorPlacementMode = z.infer<typeof ScenarioEditorActorPlacementModeSchema>;

/**
 * Provenance and runtime guard for a vehicle interaction that was rebound to a
 * different junction on the same map. The ids are deliberately topology ids,
 * not CARLA actor ids: the concrete road anchors and dense path remain the
 * worker input, while this block makes stale/partial relocation output
 * distinguishable from an ordinary authored timed path.
 */
export const InteractionRelocationActorProvenanceSchema = z
  .object({
    schemaVersion: z.literal("simforge.interaction-relocation.v1"),
    sourceJunctionId: z.string().trim().min(1),
    targetJunctionId: z.string().trim().min(1),
    sourceGateId: z.string().trim().min(1),
    targetGateId: z.string().trim().min(1),
    turnRelation: z.enum(["Left", "Right", "Straight"]),
    topologyXodrSha256: z.string().trim().min(1),
  })
  .strict();
export type InteractionRelocationActorProvenance = z.infer<
  typeof InteractionRelocationActorProvenanceSchema
>;

export const CrossMapActorTransferProvenanceSchema = z
  .object({
    schemaVersion: z.literal("simforge.cross-map-actor-transfer.v2"),
    motifHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    formationId: z.string().trim().min(1),
    formationHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    formationContractHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    matchId: z.string().trim().min(1),
    sourceScenarioId: z.string().trim().min(1),
    sourceMapAssetId: z.string().trim().min(1),
    targetMapAssetId: z.string().trim().min(1),
    targetFeatureGraphRevision: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    sourceActorId: z.string().trim().min(1),
  })
  .strict();
export type CrossMapActorTransferProvenance = z.infer<
  typeof CrossMapActorTransferProvenanceSchema
>;

/**
 * Structured origin for an EPHEMERAL actor expanded out of the scene's ambient
 * traffic region. Part of the ambient-traffic contract with
 * `ScenarioEditorAmbientTrafficSchema` below.
 *
 * `expandRandomTrafficActors` stamps it on every generated member and nothing
 * else does. It is the machine-readable form of the id convention
 * (`<regionId>:vehicle:<memberIndex>`): `regionId` is the region's
 * `legacyActorId` and `memberIndex` is the 1-based ordinal in the member id.
 *
 * An actor carrying this origin must NEVER be persisted — the region spec is
 * what saves, and members are recomputed at every payload build
 * (`draft-normalization.ts` refuses to serialize one). It is likewise stripped
 * from the CARLA wire (`projectRuntimeActorWirePayload`): the worker has no
 * reader for it, and provenance the runtime cannot act on does not ship.
 */
export const AmbientRegionOriginSchema = z
  .object({
    kind: z.literal("ambient_region"),
    regionId: z.string().min(1),
    memberIndex: z.number().int().min(1),
  })
  .strict();
export type AmbientRegionOrigin = z.infer<typeof AmbientRegionOriginSchema>;

const ScenarioEditorActorRoleSchema = z.enum(["subject", "traffic", "pedestrian", "prop"]);

export const ScenarioEditorActorDraftSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(["vehicle", "walker", "prop"]),
  role: ScenarioEditorActorRoleSchema.default("traffic"),
  is_static: z.boolean().default(false),
  /**
   * True only for a vehicle SYNTHESIZED inside a random-traffic region by
   * `expandRandomTrafficActors`, and stamped by nothing else.
   *
   * It exists because "did an author decide this?" is a question several places
   * need and no other field answers. `role: "traffic"` is the schema DEFAULT, so
   * every hand-placed car that carries no sensors has the same value; the
   * generated id shape (`<region>:vehicle:<n>`) is an implementation detail of
   * one expander. Both were tried as the discriminator and both were wrong in
   * the same direction — they made the editor guess on cars somebody had placed
   * by hand (see `junction-direction.ts`).
   *
   * Expanded actors are ephemeral: the region spec is what gets persisted, so
   * this never appears in a saved draft.
   *
   * Kept alongside `origin` rather than replaced by it: this flag is the
   * SEMANTIC discriminator junction routing branches on
   * (`junction-direction.ts`), and pre-migration drafts carry baked snapshots
   * with the flag but no origin. `origin` adds the provenance (which region,
   * which member) the flag cannot express.
   */
  ambient_generated: z.boolean().optional(),
  /** Structured provenance for an ambient-region member. See
   * `AmbientRegionOriginSchema` — ephemeral, never persisted, never on the
   * CARLA wire. */
  origin: AmbientRegionOriginSchema.optional(),
  placement_mode: ScenarioEditorActorPlacementModeSchema.default("road"),
  blueprint: z.string(),
  spawn: ScenarioEditorRoadAnchorSchema,
  spawn_point: ScenarioEditorMapPointSchema.nullable().optional(),
  spawn_yaw: z.number().optional(),
  route: z.array(ScenarioEditorRoadAnchorSchema).default([]),
  route_direction: z.enum(["forward", "reverse"]).default("forward"),
  lane_facing: z.enum(["with_lane", "against_lane"]).default("with_lane"),
  destination: ScenarioEditorRoadAnchorSchema.nullable().optional(),
  destination_point: ScenarioEditorMapPointSchema.nullable().optional(),
  /** Default road-vehicle/autopilot target: 30 mph in the km/h runtime contract. */
  speed_kph: z.number().min(0).default(48.28032),
  /** Route-follower stop-line stop: the worker eases this actor to a controlled stop at
   * the nearest stop-line landmark ahead on its route (nominal `stop` / stop_line).
   * NOTE: this is a COMPLIANCE flag (don't blow a stop sign) — lane_keep and turn egos
   * carry it too. It is NOT a statement of scenario intent; use `expected_maneuver`. */
  stop_at_stop_line: z.boolean().optional(),
  /** The maneuver this actor's scenario is ABOUT — the ground truth the
   * maneuver/scene metrics score against. Route-follower egos (lane_keep, the
   * cause-first stop, ramps) carry NO maneuver clips, so the worker cannot
   * derive intent from the program and previously guessed it from `stop_at_stop_line`
   * — which made every lane_keep ego score against a "stop" expectation and get
   * auto-rejected by the 2D gate. Set explicitly by the generator; the worker
   * prefers it over any inference. */
  expected_maneuver: z
    .enum(["lane_keep", "lane_change_left", "lane_change_right", "turn_left", "turn_right", "stop"])
    .optional(),
  color: z.string().nullable().optional(),
  /**
   * The unified control model: trigger-started clips — the ONE authored motion
   * surface. Every actor the load path accepts carries one; the field is
   * optional on the TYPE only so a constructor can build the placement first
   * and derive the base clip from it (`normalizeActorBaseClip`) before the
   * draft is persisted.
   */
  behavior: ActorBehaviorProgramSchema.optional(),
  /** Actor-level reactive safety layer. Standing property, not a clip: it must
   * be able to interrupt whatever clip is running. */
  reaction_profile: ReactionProfileSchema.optional(),
  /**
   * The one actor this actor's scenario is ABOUT hitting or nearly hitting —
   * conflict IDENTITY, declared by the generator on the subject. It is not a
   * braking exemption (`reaction_profile.exempt_actor_ids` is) and it does not
   * arm anything (a walker's release is its own proximity-triggered clip):
   * readers use it to know which pair is the planned conflict, e.g. to keep
   * ambient wandering off the pair and to score the outcome against it.
   */
  intended_conflict_actor_id: z.string().trim().min(1).optional(),
  interaction_relocation: InteractionRelocationActorProvenanceSchema.optional(),
  cross_map_transfer: CrossMapActorTransferProvenanceSchema.optional(),
  semantic_authoring: SemanticActorAuthoringSchema.optional(),
  timed_waypoints: z.array(ScenarioEditorTimedWaypointSchema).optional(),
  /** Precise Phase-1a parking maneuver (rear-axle, cusped, gear-aware) for a
   * `timed_path` parking ego. Emitted by the parking-maneuver core; executed by
   * the worker's parking executor. */
  parking_maneuver: ParkingManeuverSchema.optional(),
  /**
   * How the worker reads `timed_waypoints[].time`.
   *
   * "ordering" (the default, and every draft written before 2026-07-25): the
   * times order the polyline and nothing more — vehicles follow it with
   * arc-length pure pursuit at `speed_kph`. This is the behavior every existing
   * timed_path vehicle has today and it is preserved bit-for-bit.
   *
   * "schedule": the times are arrival times the runtime must hit. Speed is
   * derived per segment as distance/duration; coincident points are a hold;
   * `speed_kph` on a waypoint is ignored. Walkers already behave as "schedule"
   * unconditionally and ignore this field.
   */
  path_timing: z.enum(["ordering", "schedule"]).optional(),
  /**
   * Authoring cadence in seconds — the interval each appended point advances the
   * clock. The runtime never reads it (times are materialized per waypoint); it
   * exists so the editor can stamp, re-time after an insert, draw the dock ticks,
   * and assert the index × cadence = time invariant on load.
   */
  path_cadence_s: z.number().positive().max(5).optional(),
  path_placement: z.array(ScenarioEditorMapPointSchema).optional(),
  path_spacing: z.number().optional(),
  sensors: z.array(SensorSchema).default([]),
  behaviorMetadata: ActorBehaviorMetadataSchema.optional(),
}).passthrough();
export type ScenarioEditorActorDraft = z.infer<typeof ScenarioEditorActorDraftSchema>;

/**
 * Validation intent carried on a draft so the esmini-in-the-loop verdict and
 * repair are driven by the scenario's declared collision family rather than a
 * hardcoded assumption. Written by the collision-scenario builder; consumed by
 * the validation orchestrator + Lambda. Optional — hand-authored drafts (or
 * drafts predating this field) omit it and the validator falls back to
 * `collision` defaults.
 */
export const ScenarioValidationIntentSchema = z.object({
  /** What the scripted esmini rollout should produce. */
  expectedOutcome: z.enum(["collision", "near_miss"]),
  /** Planned time-of-impact (s) the actors were back-calculated to. */
  conflictTimeS: z.number(),
});
export type ScenarioValidationIntent = z.infer<typeof ScenarioValidationIntentSchema>;

export const ScenarioEditorMetadataSchema = z.object({
  sourceScenarioId: z.string(),
  mapAssetId: z.string(),
  mapName: z.string(),
  backendMapName: z.string().optional(),
  activeScenarioSimulationId: z.string().nullable().optional(),
  latestScenarioSimulationId: z.string().nullable().optional(),
  notes: z.string().default(""),
  worldSensorYawBasis: z.string().optional(),
  validationIntent: ScenarioValidationIntentSchema.optional(),
  scenarioIntention: ScenarioIntentionSchema.optional(),
  scenarioMetadata: ScenarioMetadataSchema.optional(),
  /**
   * Generation-time actor-randomness seed, pinned by the deterministic
   * generators (Engine A/B stamp their per-scene seed here). When present the
   * runtime payload builder uses it as the EXPLICIT `behavior_seed` +
   * `traffic_manager_seed` instead of the semantic_default content hash — so
   * editing one actor (the 2D repair loop retiming the conflict walker) no
   * longer re-rolls the TM seed for every ambient actor (invariant: "change
   * only the conflicting actor and the rest of the scene stays the same").
   * Non-negative safe integer.
   */
  actorRandomnessSeed: z.number().int().nonnegative().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ScenarioEditorMetadata = z.infer<typeof ScenarioEditorMetadataSchema>;

export const PhysicsProfileIdSchema = z.enum([
  "carla_default",
  "nvidia_aligned",
]);
export type PhysicsProfileId = z.infer<typeof PhysicsProfileIdSchema>;

export function normalizePhysicsProfileId(value: unknown): PhysicsProfileId {
  const parsed = PhysicsProfileIdSchema.safeParse(value);
  return parsed.success ? parsed.data : SIMULATION_DEFAULTS.physicsProfileId;
}

export const ScenarioEditorSimulationConfigSchema = z.object({
  duration_seconds: z.number().min(1).max(60).default(SIMULATION_DEFAULTS.durationSeconds),
  fixed_delta_seconds: z.number().min(0.01).max(0.2).default(SIMULATION_DEFAULTS.fixedDeltaSeconds),
  physics_profile_id: PhysicsProfileIdSchema.default(
    SIMULATION_DEFAULTS.physicsProfileId,
  ),
});
export type ScenarioEditorSimulationConfig = z.infer<typeof ScenarioEditorSimulationConfigSchema>;

/**
 * Draft schema v2: recording config lives on individual sensors in the ego
 * rig (not draft-level). worldSensors carries world-placed sensors.
 *
 * The legacy v1 schema and v1->v2 transform were removed after a staging
 * Aurora audit confirmed zero scenario_drafts rows at schema_version null/1
 * (all 57 rows at v2). Drafts at schema_version=1 are now rejected at parse.
 */
/**
 * Ambient traffic: a property of the SCENE, not an actor in it.
 *
 * The Traffic Manager cars were authored as one actor carrying a
 * `random_traffic_region` config, which the payload build expanded into as many
 * as 112 ephemeral vehicles. That made background traffic look like something an
 * author had placed — it appeared in the actor list, could be selected, given a
 * behavior program it would never run, and counted against every "how many
 * actors does this scenario have" question. Statistical behaviour is correct for
 * background and only ever wrong as authored intent
 * (`plans/2026-07-29-one-motion-model.md` §2.4).
 *
 * ## The ONE persisted home
 *
 * This field lives at `setup.scene.ambientTraffic` in the portable/persisted
 * v3 setup (`draft-normalization.ts::ScenarioSetupJsonV3`) and as the
 * `ambientTraffic` field of the native editor draft below — nowhere else. The
 * draft PUT route hoists a still-actor-shaped region into it at the write
 * boundary; normalization reads it back and serialization round-trips it, so
 * the declarative spec survives every save. The expander's OUTPUT never
 * persists: members carry `origin.kind === "ambient_region"` and the
 * serializers refuse them.
 *
 * ## `legacyActorId` is load-bearing, not vestigial
 *
 * The expander derives each generated car's id as `<region-actor-id>:vehicle:<n>`,
 * so the region actor's id is IN THE WIRE PAYLOAD of every ambient car. Moving
 * the config to the scene without carrying that id would renumber all 112 of
 * them and break the byte-identical requirement this migration is gated on. So
 * the id travels with the field, and the payload build synthesizes the same
 * actor the draft used to persist.
 *
 * ## What `region` carries
 *
 * The COMPLETE declarative population request — everything expansion is a
 * deterministic function of: `bounds`, `count`, the four seeds
 * (`placementSeed` / `colorSeed` / `blueprintSeed` / `speedSeed`),
 * `randomizeColors` / `randomizeBlueprints`, `minimumSpacingMeters`,
 * `baseSpeedKph`, `aggressiveness`, and the `blueprintPool` / `colorPool`
 * allowlists. Shaped as a passthrough of the editor's own
 * `RandomTrafficRegionConfig` rather than a re-declaration: the config is owned
 * by `apps/web/app/lib/scenario-editor/random-traffic-region.ts` and
 * duplicating it here is how two copies drift. What this schema pins is the
 * part the migration depends on.
 */
export const ScenarioEditorAmbientTrafficSchema = z
  .object({
    /** The id the retired region actor had. See above — do not regenerate it. */
    legacyActorId: z.string().min(1),
    /** The retired region actor's `spawn_point`; the expander reads it. */
    spawnPoint: ScenarioEditorMapPointSchema.nullable().optional(),
    region: z.object({ kind: z.literal("random_traffic_region") }).passthrough(),
  })
  .passthrough();
export type ScenarioEditorAmbientTraffic = z.infer<
  typeof ScenarioEditorAmbientTrafficSchema
>;

export const ScenarioEditorDraftSchema = z.object({
  version: z.literal(2),
  metadata: ScenarioEditorMetadataSchema,
  simulationConfig: ScenarioEditorSimulationConfigSchema.optional(),
  actors: z.array(ScenarioEditorActorDraftSchema).default([]),
  /**
   * Background traffic, expanded at payload build. The native-draft spelling of
   * the one scene home (`setup.scene.ambientTraffic` in the persisted v3
   * setup) — see `ScenarioEditorAmbientTrafficSchema`. `.optional()` for the
   * same reason as `signalPlans` below: a default would make the inferred type
   * required on every draft literal in the repo for a field that means nothing
   * when absent.
   */
  ambientTraffic: ScenarioEditorAmbientTrafficSchema.optional(),
  /**
   * Traffic-signal authoring, one plan per junction the author touched
   * (plan 2026-07-24, section 4.3). Draft-level rather than per-actor because a
   * junction belongs to the SCENE, not to any car: it is the SCENE lane's data.
   * Absent or empty means every junction runs `map_default`, which is exactly
   * what every draft written before this field did.
   *
   * `.optional()` rather than `.default([])` on purpose: a default makes the
   * INFERRED type required, which would break every `ScenarioEditorDraft`
   * object literal in the repo for a field that means nothing when absent.
   * Same call as `semanticFormations` next door. Read it as
   * `draft.signal_plans ?? []`.
   */
  signal_plans: z.array(JunctionSignalPlanSchema).optional(),
  semanticFormations: z.array(SceneFormationSchema).optional(),
  semanticFormationSolutions: z.array(SceneFormationSolutionSchema).optional(),
  selectedActorId: z.string().nullable().optional(),
  worldSensors: z.array(SensorSchema).default([]),
  carLedTrafficEnabled: z.boolean().default(false),
  carLedTrafficCarsPerActor: z.number().int().min(1).max(20).default(4),
  carLedTrafficRadiusMeters: z.number().int().min(5).max(100).default(30),
  carLedTrafficMinimumSpacingMeters: z.number().int().min(2).max(40).default(8),
  /** Per-car desired-speed band and headway scaling for car-led traffic. */
  carLedTrafficAggressiveness: TrafficAggressiveness.optional(),
  /** The speed that band multiplies. Not the posted limit — the runtime road
   * overlay carries none, so this knob stands in for it. */
  carLedTrafficBaseSpeedKph: z.number().int().min(5).max(130).optional(),
  /** Reroll counter: bump it for a different draw of the same settings. */
  carLedTrafficVariantSeed: z.number().int().min(0).optional(),
  trafficEnabled: z.boolean().default(false),
  trafficDensity: TrafficDensity.default("moderate"),
  trafficAggressiveness: TrafficAggressiveness.default("normal"),
  trafficVehicleCount: z.number().int().min(1).default(30),
  trafficVehicleMix: VehicleMixPreset.default("mixed"),
  trafficVehicleMixWeights: z
    .object({
      passenger: z.number().min(0).max(100).default(70),
      truck: z.number().min(0).max(100).default(20),
      bus: z.number().min(0).max(100).default(10),
    })
    .default({ passenger: 70, truck: 20, bus: 10 }),
  trafficManager: TrafficManagerSchema.nullable().optional(),
  trafficCards: z.array(TrafficCardSchema).default([]),
  selectedTrafficCardId: z.string().nullable().optional(),
  renderConfig: z
    .object({
      environmentPreset: z.record(z.unknown()).optional(),
    })
    .passthrough()
    .optional(),
});
export type ScenarioEditorDraft = z.infer<typeof ScenarioEditorDraftSchema>;

export const ScenarioEditorTemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  map_name: z.string(),
  actors: z.array(ScenarioEditorActorDraftSchema).default([]),
  selected_actor_id: z.string().nullable().optional(),
  worldSensors: z.array(SensorSchema).default([]),
  created_at: z.string(),
  updated_at: z.string(),
});
export type ScenarioEditorTemplate = z.infer<typeof ScenarioEditorTemplateSchema>;

// ---------------------------------------------------------------------------
// Derived subject
// ---------------------------------------------------------------------------

/** Anything shaped enough to answer whether it is the recording subject. */
type SubjectCandidate = Pick<ScenarioEditorActorDraft, "kind"> & {
  sensors?: unknown[];
  role?: ScenarioEditorActorDraft["role"];
};

/**
 * The scenario's recording subject: the first vehicle carrying a configured
 * sensor rig. Sensor presence is the authoritative fact because a scene records
 * what that rig observes; a separate actor designation can only disagree with
 * the actual measurement source.
 *
 * Returns null when no vehicle carries sensors. Callers mid-way through
 * BUILDING a draft want `plannedSubjectActor` instead.
 */
export function primaryActor<T extends SubjectCandidate>(actors: readonly T[]): T | null {
  return actors.find(
    (actor) => actor.kind === "vehicle" && (actor.sensors?.length ?? 0) > 0,
  ) ?? null;
}

/**
 * The subject a generator is planning around, which exists slightly before the
 * sensors do.
 *
 * A collision planner picks its principal vehicle, anchors the recipe on it,
 * times the conflict against it and only then equips it — so inside that window
 * the declared `subject` role is the only statement of intent available. This
 * is deliberately NOT `primaryActor`: nothing user-facing may call a vehicle
 * the recording subject on the strength of a label.
 */
export function plannedSubjectActor<T extends SubjectCandidate>(actors: readonly T[]): T | null {
  return primaryActor(actors)
    ?? actors.find((actor) => actor.kind === "vehicle" && actor.role === "subject")
    ?? null;
}
