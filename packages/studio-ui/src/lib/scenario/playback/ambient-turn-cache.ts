/**
 * Persist the ambient generator's turn-feasibility verdicts across editor
 * sessions.
 *
 * Since engine 0.9.0 the generator probes every tight transition with the
 * dynamic-v1 plant before routing a vehicle through it. The first generation on
 * a map pays that (about 0.6 s on Richmond, about 4 s on San Ramon, in this
 * worker's WASM build); later generations in the same worker reuse the
 * module's memo. The verdicts are a pure function of the map closure and the
 * engine semantics, so they are cached in Cache Storage keyed by both
 * (`closureDigest`, `engineSemVer`) and loaded before the first generation of
 * the next session. A cache hit changes timing, never the population.
 *
 * Cache Storage exists only in secure contexts; everywhere else this is a
 * no-op and the in-worker memo still covers the session.
 */

import type { EngineRuntime, LaneGraph } from '@simforge-oss/engine';

const CACHE_NAME = 'simforge-ambient-turn-verdicts-v1';
const restored = new Map<string, number>();
const persisted = new Map<string, number>();

function cacheKey(engineSemVer: string, closureDigest: string): string {
  return `https://simforge.invalid/ambient-turn-verdicts/${encodeURIComponent(engineSemVer)}/${closureDigest}.json`;
}

function cacheStorage(): CacheStorage | null {
  try {
    return typeof caches === 'undefined' ? null : caches;
  } catch {
    return null;
  }
}

function verdictCount(json: string): number {
  try {
    const rows = (JSON.parse(json) as { verdicts?: unknown[] }).verdicts;
    return Array.isArray(rows) ? rows.length : 0;
  } catch {
    return 0;
  }
}

/** Load persisted verdicts for this closure into the engine, once per worker. Returns the count loaded. */
export async function restoreAmbientTurnVerdicts(engine: EngineRuntime, closureDigest: string): Promise<number> {
  if (!closureDigest) return 0;
  const { engineSemVer } = engine.version();
  const key = cacheKey(engineSemVer, closureDigest);
  const known = restored.get(key);
  if (known !== undefined) return known;
  restored.set(key, 0);
  const storage = cacheStorage();
  if (!storage) return 0;
  try {
    const response = await (await storage.open(CACHE_NAME)).match(key);
    if (!response) return 0;
    const count = engine.loadAmbientTurnVerdicts(await response.text());
    restored.set(key, count);
    persisted.set(key, count);
    return count;
  } catch {
    // A table from another engine or a damaged entry: generate from scratch.
    return 0;
  }
}

/** Store the verdicts the engine now holds for this closure when they grew. Fire and forget. */
export async function persistAmbientTurnVerdicts(engine: EngineRuntime, graph: LaneGraph, closureDigest: string): Promise<void> {
  if (!closureDigest) return;
  const storage = cacheStorage();
  if (!storage) return;
  const { engineSemVer } = engine.version();
  const key = cacheKey(engineSemVer, closureDigest);
  try {
    const json = engine.ambientTurnVerdicts(graph);
    if (!json) return;
    const count = verdictCount(json);
    if (count <= (persisted.get(key) ?? 0)) return;
    persisted.set(key, count);
    await (await storage.open(CACHE_NAME)).put(key, new Response(json, { headers: { 'content-type': 'application/json' } }));
  } catch {
    // Quota or a closed cache: the in-worker memo still serves this session.
  }
}
