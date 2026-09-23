import compilerPackage from '../package.json' with { type: 'json' };

/**
 * The SimForge OSS release this build belongs to (every workspace package carries the release
 * version). Provenance only: never part of a simulation key.
 */
export const SIMFORGE_OSS_RELEASE: string = compilerPackage.version;
