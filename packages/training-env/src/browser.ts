/**
 * `@simforge-oss/training-env/browser` — sessions bound to the WASM module.
 *
 * Everything reachable from here is platform-neutral: the same façades as the
 * root, constructed over the initialised WASM runtime by `loadSessions()`. No
 * Node builtin is reachable and no TypeScript simulator exists behind it.
 */

import type { NativeModule } from '@simforge-oss/engine';
import { loadNative } from '@simforge-oss/native-runtime/browser';

import { SessionRuntime } from './runtime.js';

export * from './index.js';

let ready: Promise<SessionRuntime> | null = null;

/** Initialise the WASM runtime once; `source` is forwarded to the module loader. */
export function loadSessions(source?: RequestInfo | URL | Response | BufferSource | WebAssembly.Module): Promise<SessionRuntime> {
  if (!ready) {
    ready = loadNative(source).then((module) => new SessionRuntime(module as unknown as NativeModule));
  }
  return ready;
}
