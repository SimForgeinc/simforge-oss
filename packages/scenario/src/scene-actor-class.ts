/**
 * The render service's actor class vocabulary (`actorClass` in
 * scene-state.v1), and the one mapping from engine actor kinds onto it. The
 * same table as simforge-core `trace::scene_state::actor_class_of` (a Rust
 * test pins it) and the classes the service's semantic taxonomy accepts
 * (`renderer/sensors/src/taxonomy.rs`, which refuses any other class).
 */
export const SCENE_ACTOR_CLASSES = ['car', 'van', 'truck', 'bus', 'motorcycle', 'cyclist', 'pedestrian', 'prop'] as const;
export type SceneActorClass = typeof SCENE_ACTOR_CLASSES[number];

/** Engine actor kind → scene actor class. Bicycles and scooters are ridden (`cyclist`). */
export const SCENE_ACTOR_CLASS_OF_KIND: Readonly<Record<string, SceneActorClass>> = Object.freeze({
  vehicle: 'car', car: 'car', van: 'van', truck: 'truck', bus: 'bus', motorcycle: 'motorcycle',
  bicycle: 'cyclist', scooter: 'cyclist', pedestrian: 'pedestrian',
  // No service class of their own: rendered from their catalog model, labelled prop.
  sidewalk_robot: 'prop', drone: 'prop', animal: 'prop', static_object: 'prop',
});

export class SceneActorClassError extends Error {
  readonly code = 'scene_actor_class_unmapped';
  constructor(readonly kind: string) {
    super(`actor kind "${kind}" has no scene actor class`);
    this.name = 'SceneActorClassError';
  }
}

/** The scene actor class of an engine actor kind; an unknown kind throws. */
export function sceneActorClassOfKind(kind: string): SceneActorClass {
  const mapped = Object.hasOwn(SCENE_ACTOR_CLASS_OF_KIND, kind) ? SCENE_ACTOR_CLASS_OF_KIND[kind] : undefined;
  if (mapped === undefined) throw new SceneActorClassError(kind);
  return mapped;
}
