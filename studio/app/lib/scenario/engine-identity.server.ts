import "server-only";

import { engine } from "@simforge-oss/engine/node";

import type { SimulationPreviewEngine } from "./simulation-preview-engine";

let cached: SimulationPreviewEngine | null | undefined;

/**
 * The engine semantics this deployment runs. The editor's WASM module and the
 * server's N-API addon come from one `@simforge-oss/native-runtime` build, so
 * this is also the engine every current browser simulates with.
 *
 * `null` when the native addon cannot be loaded on this host; callers then
 * skip engine-scoped checks rather than refusing every saved simulation (the
 * browser still checks the engine before it replays one).
 */
export function serverEngineIdentity(): SimulationPreviewEngine | null {
  if (cached !== undefined) return cached;
  try {
    const { engineSemVer, abiVersion } = engine().version();
    cached = { engineSemVer, abiVersion };
  } catch (error) {
    console.warn("[simforge] native engine unavailable; saved simulations are not engine-scoped on this host", error);
    cached = null;
  }
  return cached;
}
