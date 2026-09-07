/**
 * Shared evaluation protocol: the input, result and job contracts both hosts
 * (desktop, web portal) and the cloud worker read and write.
 *
 * These modules are the single source of truth for evaluation schemas. Other
 * packages consume them; nothing here imports a host, a UI or a provider.
 */

export * from './metrics.js';
export * from './openloop.js';
export * from './manifest.js';
export * from './compute-job.js';
export * from './endpoint-client.js';
export * from './clip-input.js';
export * from './replay-envelope.js';
