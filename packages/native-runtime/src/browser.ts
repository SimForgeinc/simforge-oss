/**
 * `@simforge-oss/native-runtime/browser` — WASM entry.
 *
 * Loads the module built by `pnpm --filter @simforge-oss/native-runtime
 * build:wasm` (`wasm/simforge_native_runtime.js` + `.wasm`, wasm-pack `web`
 * target). The browser build is the supported CPU subset: filesystem map
 * corpora and GPU profiles are explicit `unsupported` errors, never a
 * TypeScript fallback.
 */

import init, * as wasm from '../wasm/simforge_native_runtime.js';

import { ABI_VERSION } from './shared.js';

export * from './shared.js';
export type * from '../wasm/simforge_native_runtime.js';

export type NativeWasm = typeof wasm;

let ready: Promise<NativeWasm> | null = null;

/**
 * Initialise the WASM module once. `source` may be a URL/Response/bytes for
 * the `.wasm` file; by default the sibling file next to the glue is fetched.
 */
export function loadNative(source?: RequestInfo | URL | Response | BufferSource | WebAssembly.Module): Promise<NativeWasm> {
  if (!ready) {
    ready = init({ module_or_path: source ?? new URL('../wasm/simforge_native_runtime_bg.wasm', import.meta.url) })
      .then(() => {
        const version = wasm.abiVersion();
        if (version !== ABI_VERSION) {
          throw new Error(`WASM module has binding ABI ${version} but this package requires ABI ${ABI_VERSION}`);
        }
        return wasm;
      })
      .catch((error: unknown) => {
        ready = null;
        throw new Error(
          `@simforge-oss/native-runtime/browser: the WASM module failed to load (${error instanceof Error ? error.message : String(error)}). ` +
            'Build it with `pnpm --filter @simforge-oss/native-runtime build:wasm` (requires the Rust toolchain and wasm-pack) and serve the wasm/ directory.',
        );
      });
  }
  return ready;
}
