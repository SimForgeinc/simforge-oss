import {
  ACTOR_BEHAVIOR_SCHEMA_VERSION,
  DEFAULT_BEHAVIOR_CLIP_END,
  DEFAULT_REACTION_AGGRESSIVENESS,
  DEFAULT_WALKER_CONFLICT_TRIGGER_DISTANCE_M,
  behaviorActorRef,
  type ActorBehaviorProgram,
  type BehaviorAction,
  type BehaviorClip,
  type BehaviorClipEnd,
  type BehaviorTrigger,
  type ReactionObstacleFilter,
  type ReactionProfile,
} from "@simforge-oss/scenario/contracts";
import {
  baseActionForDraft,
  baseClipId,
  normalizeActorBaseClip,
  type ScenarioEditorActorDraft,
} from "@simforge-oss/studio-shared";

/**
 * Generator-side authoring of an actor's control model.
 *
 * A generator decides placement first — spawn, route, timed waypoints — and
 * then says, in the editor's own dialect, what the actor DOES: a base clip
 * (derived from the placement unless the generator has a different baseline in
 * mind), the interaction clips that fire on top of it, the actor-level reaction
 * profile, and the intended conflict. Nothing here is an intermediate shape:
 * the program written is the program persisted and executed.
 */

/** An interaction clip as a generator states it; `role` and `enabled` are stamped here. */
export type GeneratedInteractionClip = {
  id: string;
  label?: string;
  action: BehaviorAction;
  trigger?: BehaviorTrigger;
  end?: BehaviorClipEnd;
};

export type GeneratedActorAuthoring = {
  /**
   * The baseline. Defaults to what the placement describes
   * (`baseActionForDraft`): a path actor follows its points, a walker walks
   * them, a road car cruises. A generator overrides the action to hand a
   * background car to the Traffic Manager, or the trigger to arm a conflict
   * walker's crossing on the ego's approach instead of on the clock.
   */
  base?: { action?: BehaviorAction; trigger?: BehaviorTrigger };
  interactions?: readonly GeneratedInteractionClip[];
  reactionProfile?: ReactionProfile;
  /** Conflict IDENTITY only — see `ScenarioEditorActorDraftSchema.intended_conflict_actor_id`. */
  intendedConflictActorId?: string;
};

/**
 * Author a generated actor's behavior program and reaction profile onto its
 * placement draft, then normalize it exactly as the editor would.
 */
export function authorGeneratedActor(
  actor: ScenarioEditorActorDraft,
  authoring: GeneratedActorAuthoring = {},
): ScenarioEditorActorDraft {
  const baseClip: BehaviorClip = {
    id: baseClipId(actor.id),
    role: "base",
    enabled: true,
    trigger: authoring.base?.trigger ?? { kind: "at_time", t: 0 },
    end: DEFAULT_BEHAVIOR_CLIP_END,
    action: authoring.base?.action ?? baseActionForDraft(actor),
  };
  const interactions: BehaviorClip[] = (authoring.interactions ?? []).map((clip) => ({
    id: clip.id,
    ...(clip.label === undefined ? {} : { label: clip.label }),
    role: "interaction",
    enabled: true,
    trigger: clip.trigger ?? { kind: "at_time", t: 0 },
    end: clip.end ?? DEFAULT_BEHAVIOR_CLIP_END,
    action: clip.action,
  }));
  const behavior: ActorBehaviorProgram = {
    schema_version: ACTOR_BEHAVIOR_SCHEMA_VERSION,
    clips: [baseClip, ...interactions],
    conflict_policy: "overwrite",
  };
  const {
    reaction_profile: _reactionProfile,
    intended_conflict_actor_id: _intendedConflictActorId,
    ...placement
  } = actor;
  return normalizeActorBaseClip({
    ...placement,
    behavior,
    ...(authoring.reactionProfile ? { reaction_profile: authoring.reactionProfile } : {}),
    ...(authoring.intendedConflictActorId
      ? { intended_conflict_actor_id: authoring.intendedConflictActorId }
      : {}),
  });
}

/**
 * The reaction profile of an actor that brakes for what is ahead.
 *
 * `obstacleFilter: "stopped_vehicles"` is the narrow scan a staged crosser
 * carries: it stays assertive through its conflict with the moving ego and
 * only brakes for a car that has already stopped dead ahead. It is NOT the
 * broad `"all"` scan with an exemption — the broad scan would brake for the
 * ego itself, which is the one actor the crosser must not yield to.
 */
export function brakeReactionProfile(options: {
  exemptActorIds?: readonly string[];
  obstacleFilter?: ReactionObstacleFilter;
} = {}): ReactionProfile {
  return {
    mode: "brake",
    aggressiveness: DEFAULT_REACTION_AGGRESSIVENESS,
    exempt_actor_ids: [...(options.exemptActorIds ?? [])],
    obstacle_filter: options.obstacleFilter ?? "all",
  };
}

/**
 * The reaction profile of a CONTACT actor: it does not react, and the Traffic
 * Manager's own collision avoidance is switched off for exactly the pair it is
 * meant to hit (`collision_detection(self, target, False)`), so the TM's
 * strict rules cannot brake it out of its own conflict.
 */
export function contactReactionProfile(targetActorId: string): ReactionProfile {
  return {
    mode: "none",
    aggressiveness: DEFAULT_REACTION_AGGRESSIVENESS,
    exempt_actor_ids: [targetActorId],
    obstacle_filter: "all",
  };
}

/**
 * The trigger that releases a conflict walker to cross: the ego closing to
 * within the shared conflict distance, rather than a wall-clock time. The
 * walker's crossing is its base clip; this trigger is what turns the authored
 * schedule into a closed-loop step-off in front of the car.
 */
export function walkerReleaseOnApproach(egoActorId: string): BehaviorTrigger {
  return {
    kind: "proximity",
    actor: "self",
    other: behaviorActorRef(egoActorId),
    distance_m: DEFAULT_WALKER_CONFLICT_TRIGGER_DISTANCE_M,
    mode: "closer",
  };
}
