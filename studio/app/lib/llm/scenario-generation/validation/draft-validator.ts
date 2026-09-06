/**
 * Draft acceptance.
 *
 * A generated collision draft is accepted by executing the authored candidate
 * it lowers to — the map-bound template the host persists — in the native
 * runtime and reading the runtime's contacts, closest approach and pose
 * samples (`@simforge-oss/studio-host/node`). This adapter binds the host's
 * draft type, subject resolution and plausibility lint to that shared
 * validator; it holds no motion or contact logic of its own.
 */
import {
  fromPreviewFrames,
  lintActorTracks,
  plannedSubjectActor,
  type CollisionFamilyId,
  type ScenarioEditorActorDraft,
  type ScenarioIntention,
  type ScenarioValidationReport,
} from "@simforge-oss/studio-shared";
import {
  lowerCollisionDraftCandidate,
  validateCollisionDraft as validateCollisionDraftNatively,
  type CollisionConflictHint,
  type CollisionDraftMapBinding,
  type LoweredCollisionDraft,
} from "@simforge-oss/studio-host/node";

export type { CollisionConflictHint, CollisionDraftMapBinding, LoweredCollisionDraft };

export interface ValidateCollisionDraftArgs {
  family: CollisionFamilyId;
  /**
   * The authored outcome to judge. Planning probes request `collision` (they
   * prove the conflict geometry converges); the assembled candidate is judged
   * against its stamped `scenarioIntention.outcome`.
   */
  outcome: ScenarioIntention["outcome"];
  actors: readonly ScenarioEditorActorDraft[];
  /** The immutable map the candidate executes on. */
  map: CollisionDraftMapBinding;
  /** The family template's environment preset the candidate executes under. */
  environmentPreset: unknown;
  /**
   * The lowered candidate, when the caller persists exactly what it validates.
   * A planning probe lowers `actors` through the same shared draft lowering.
   */
  lowered?: LoweredCollisionDraft;
  /** Intended scenario location (document/candidate center), runtime meters.
   *  Falls back to the conflict hint when the geometry had no center. */
  intendedLocation: { x: number; y: number } | null;
  /** Planner output. Null when the builder fell back to heuristic placement
   *  — the report still runs but timing/region checks soften to warnings. */
  conflict: CollisionConflictHint | null;
  durationS: number;
}

export function validateCollisionDraft(args: ValidateCollisionDraftArgs): ScenarioValidationReport {
  const { environmentPreset, ...rest } = args;
  return validateCollisionDraftNatively({
    ...rest,
    lowered: args.lowered ?? lowerCollisionDraftCandidate({
      name: `${args.family} probe`,
      appVersion: "simforge.collision-draft-probe",
      actors: args.actors,
      map: args.map,
      durationS: args.durationS,
      environmentPreset,
      notes: "",
      extensions: {},
    }),
    subjectActorId: plannedSubjectActor(args.actors)?.id ?? null,
    // The lint derives speed from the runtime's positions, as it does for every track.
    lint: (frames, actorKinds) =>
      lintActorTracks(
        fromPreviewFrames(
          frames.map((frame) => ({
            ...frame,
            actors: frame.actors.map(({ speed: _speed, ...actor }) => actor),
          })),
          actorKinds,
        ),
      ),
  });
}
