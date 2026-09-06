/**
 * `@simforge-oss/training-env/node` — sessions bound to the N-API addon.
 */

import { native } from '@simforge-oss/native-runtime';

import { SessionRuntime } from './runtime.js';

export * from './index.js';

let runtime: SessionRuntime | null = null;

/** The process-wide session runtime over the loaded addon. */
export function sessions(): SessionRuntime {
  if (!runtime) runtime = new SessionRuntime(native());
  return runtime;
}
