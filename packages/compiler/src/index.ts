/**
 * `@simforge-oss/compiler` — host-neutral compiler contracts.
 *
 * Matching, materialisation, situation rehearsal and site binding execute in
 * the native compiler; this root carries the documents they read and write
 * (anchor vocabulary, matched sites, instance manifests, signal catalogs),
 * the structured error type, and the authoring-side DTO helpers. The Node
 * entry (`./node`) binds the operations to the loaded native runtime.
 */

export * from './errors.js';
export * from './anchor/index.js';
export * from './map-signals.js';
export * from './materialize.js';
export * from './match.js';
export * from './catalog.js';
export * from './xodr-elevation.js';
export * from './studio/body-color.js';
export * from './studio/parked-cars.js';
export * from './template-axis-clamp.js';
export { lowerSensor } from './perception.js';
export { MapBundle } from './types.js';
export type { InstalledMapBundle, MapBundleArtifacts } from './types.js';
export type {
  AuthorityKind,
  BoundSituation,
  CompiledSituation,
  GeneratedStaticGeometryDescriptor,
  SituationCompileOptions,
  SituationComparison,
  SituationConstraintWitness,
  SituationEventWitness,
  SituationMaterializeOptions,
  SituationPolicyHook,
  SituationRehearsal,
  SituationRehearsalOptions,
  SituationSolveOptions,
  SituationSolveResult,
  VerifiedStaticGeometryBinding,
} from './situation.js';
