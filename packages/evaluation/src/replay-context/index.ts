/**
 * Clip → replayable-scene: input contracts, importers, reconstruction and validity gates.
 *
 * The one-paragraph version: a recorded clip is only evaluable to the degree it carries
 * calibration, timing and ego state; it is only *replayable* if a reconstruction of the world
 * exists; and that reconstruction may only carry a policy inside a region we measured. Every
 * export below serves one of those three statements, and the module refuses rather than
 * guesses whenever an input falls short.
 *
 * Consumers:
 *   - the episode runner reads `<bundleDir>/replay-context.json` directly (`validity.envelope`,
 *     `ego.recordedPath`) and truncates an episode that leaves the envelope;
 *   - the compute worker runs `cli.ts` for `reconstruct.nurec`;
 *   - the desktop uses the importers and `admit` to decide what a user's clip can do.
 */

export * from './schema.js';
export * from './refusal.js';
export * from './cameras.js';
export * from './clip.js';
export * from './gates.js';
export * from './envelope.js';
export * from './qualify.js';
export * from './usdz.js';
export { CapabilityError, buildSceneStateStream, measureProbe, qualifyRenders, readSceneDirFacts, renderProbe, PROBE_TICK_HZ } from './render.js';
export type { ProbeMeasurement, ProbeOffset, QualifyOptions, QualifyResult, RenderTier, SceneStateDoc } from './render.js';
export * from './reconstruct.js';
export * from './outcome.js';
export * from './tier-lock.js';
export * from './video.js';
export * from './importers/nurec.js';
export * from './importers/package.js';
export * from './importers/alpasim.js';
export * from './importers/user-bundle.js';
export { main as sceneCli } from './cli.js';
