/**
 * `@simforge-oss/engine/browser` — the engine façade bound to the WASM module.
 *
 * `loadEngine()` initialises the WASM runtime once and returns the same
 * `EngineRuntime` API the Node entry exposes. Filesystem map corpora
 * (`MapBundle.load`) are rejected by the module itself as `unsupported`; use
 * `mapFromTopology`. No TypeScript fallback exists.
 */

import { loadNative } from '@simforge-oss/native-runtime/browser';

import type { NativeModule } from './native-module.js';
import { EngineRuntime } from './runtime.js';

export * from './index.js';

let ready: Promise<EngineRuntime> | null = null;

/**
 * Initialise the WASM runtime once. `source` is forwarded to the module loader
 * (URL / Response / bytes for the `.wasm` file; default: the sibling file).
 */
export function loadEngine(source?: RequestInfo | URL | Response | BufferSource | WebAssembly.Module): Promise<EngineRuntime> {
  if (!ready) {
    ready = loadNative(source).then((module) => new EngineRuntime(module as unknown as NativeModule));
  }
  return ready;
}
