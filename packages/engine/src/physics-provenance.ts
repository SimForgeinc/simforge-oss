import type { ActorKind } from './schema/input.js';
import type { ActorPhysicsBackendProvenance } from './trace/trace.js';

/**
 * Report the backend an actor is declared to execute under. A pure classifier
 * of the input contract shared by diagnostics and exporters so those surfaces
 * cannot make broader fidelity claims than the native engine; the executed
 * provenance is recorded in `trace.header.physics`.
 *
 * There is one motion backend, so the only distinction left is whether the
 * actor moves at all: a static actor or prop is held by the fixed-static
 * plant, and everything else is a `dynamic-v1` body.
 */
export function actorPhysicsBackend(
  actor: { readonly kind: ActorKind; readonly static: boolean },
): ActorPhysicsBackendProvenance {
  return actor.static || actor.kind === 'static_object'
    ? { mode: 'fixed-static-v1', reason: 'static-actor', profile: 'fixed-static' }
    : { mode: 'dynamic-v1', reason: 'selected', profile: actor.kind };
}

export function actorPhysicsBackends(
  actors: readonly { readonly id: string; readonly kind: ActorKind; readonly static: boolean }[],
): Record<string, ActorPhysicsBackendProvenance> {
  return Object.fromEntries(actors.map((actor) => [actor.id, actorPhysicsBackend(actor)]));
}

/**
 * Tally recorded backends. `kinematic` stays in the shape because archived
 * evidence recorded under the removed choreography backend still displays.
 */
export function physicsBackendCounts(
  backends: Readonly<Record<string, { readonly mode: ActorPhysicsBackendProvenance['mode'] }>>,
): { readonly dynamic: number; readonly kinematic: number; readonly fixed: number } {
  let dynamic = 0;
  let kinematic = 0;
  let fixed = 0;
  for (const backend of Object.values(backends)) {
    if (backend.mode === 'dynamic-v1') dynamic += 1;
    else if (backend.mode === 'fixed-static-v1') fixed += 1;
    else kinematic += 1;
  }
  return { dynamic, kinematic, fixed };
}
