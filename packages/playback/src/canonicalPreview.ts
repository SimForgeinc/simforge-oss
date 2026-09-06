import { contentHash, type EngineRuntime, type LaneGraph, type SimResult, type SimScenarioInput } from '@simforge-oss/engine';

const canonicalPreviewCache = new Map<string, SimResult>();
const CANONICAL_PREVIEW_CACHE_LIMIT = 16;

/**
 * Runs the only behavioral preview used by Studio: the native fixed-step
 * engine for the complete episode over `graph` (whose bundle already carries
 * the map's static colliders). Playback receives this same object when its
 * input hash is unchanged, so there is no second planner to disagree with.
 */
export function runCanonicalPreview(engine: EngineRuntime, input: SimScenarioInput, graph: LaneGraph): SimResult {
  const key = contentHash({ input, graphDigest: graph.byteDigest });
  const cached = canonicalPreviewCache.get(key);
  if (cached) return cached;
  const result = engine.runSimulation(input, { graph });
  canonicalPreviewCache.set(key, result);
  if (canonicalPreviewCache.size > CANONICAL_PREVIEW_CACHE_LIMIT) {
    canonicalPreviewCache.delete(canonicalPreviewCache.keys().next().value!);
  }
  return result;
}

export function clearCanonicalPreviewCache(): void {
  canonicalPreviewCache.clear();
}

export function canonicalPreviewCacheSize(): number {
  return canonicalPreviewCache.size;
}
