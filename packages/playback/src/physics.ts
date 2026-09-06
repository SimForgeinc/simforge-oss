import {
  actorPhysicsBackend,
  type ActorPhysicsBackendProvenance,
  type MotionPhysicsMode,
  type SimScenarioInput,
} from '@simforge-oss/engine';

export type PhysicsDisplayReason = ActorPhysicsBackendProvenance['reason'] | 'provenance-unavailable';

export interface ActorPhysicsDisplay {
  readonly id: string;
  readonly label: string;
  readonly mode: ActorPhysicsBackendProvenance['mode'] | null;
  readonly reason: PhysicsDisplayReason;
  readonly profile?: ActorPhysicsBackendProvenance['profile'];
}

export interface PhysicsDisplaySummary {
  readonly mode: MotionPhysicsMode;
  readonly actors: readonly ActorPhysicsDisplay[];
  readonly dynamicCount: number;
  readonly fallbackCount: number;
  readonly staticCount: number;
  readonly unknownCount: number;
}

/**
 * Deterministic editable-document migration. Immutable evidence never calls
 * this helper: playback uses its recorded trace directly.
 */
export function withEditablePhysicsDefault(input: SimScenarioInput): SimScenarioInput {
  return input.physics?.mode === 'dynamic-v1'
    ? input
    : { ...input, physics: { ...input.physics, mode: 'dynamic-v1' } };
}

export function physicsReasonLabel(reason: PhysicsDisplayReason): string {
  switch (reason) {
    case 'selected': return 'Selected backend';
    case 'static-actor': return 'Static actor';
    case 'provenance-unavailable': return 'Per-actor provenance was not recorded';
  }
}

function summarize(mode: MotionPhysicsMode, actors: readonly ActorPhysicsDisplay[]): PhysicsDisplaySummary {
  return {
    mode,
    actors,
    dynamicCount: actors.filter((actor) => actor.mode === 'dynamic-v1').length,
    fallbackCount: actors.filter((actor) => actor.mode === 'kinematic-v1' && actor.reason !== 'selected').length,
    staticCount: actors.filter((actor) => actor.mode === 'fixed-static-v1').length,
    unknownCount: actors.filter((actor) => actor.mode === null).length,
  };
}

/** Preview provenance, computed without mutating or materializing authored data. */
export function physicsSummaryForAuthoredActors(actors: readonly {
  readonly id: string;
  readonly label?: string | undefined;
  readonly simulationKind: string;
  readonly static: boolean;
  readonly reverse: boolean;
}[]): PhysicsDisplaySummary {
  const displays = actors.map((actor): ActorPhysicsDisplay => {
    const backend = actorPhysicsBackend({
      kind: actor.simulationKind as never,
      static: actor.static,
      tags: actor.reverse ? ['motion:reverse'] : [],
    }, { mode: 'dynamic-v1' });
    return { id: actor.id, label: actor.label || actor.id, ...backend };
  });
  return summarize('dynamic-v1', displays);
}

export function physicsForActor(summary: PhysicsDisplaySummary, actorId: string): ActorPhysicsDisplay | null {
  return summary.actors.find((actor) => actor.id === actorId) ?? null;
}
