/**
 * Clip → replayable-scene contracts: input documents, validity gates and the envelope.
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
 *   - the campaign runner loads a bundle for a replay-context scenario and enforces its
 *     qualification;
 *   - scene providers (importers, reconstruction, renderers) build on these contracts from
 *     their own packages: none of them lives here.
 */

export * from './schema.js';
export * from './refusal.js';
export * from './cameras.js';
export * from './clip.js';
export * from './gates.js';
export * from './envelope.js';
export * from './bundle-io.js';
export * from './drivable.js';
export * from './lanes.js';
export * from './capability.js';
export * from './outcome.js';
export * from './video.js';
export * from './digest.js';
export * from './deferred.js';
