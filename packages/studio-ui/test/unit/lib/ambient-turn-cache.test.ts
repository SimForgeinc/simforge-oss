import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EngineRuntime, LaneGraph } from '@simforge-oss/engine';

const table = (count: number) => JSON.stringify({ schema: 'simforge.ambient-turn-verdicts/v1', engineSemVer: '0.9.0', classes: ['car'], verdicts: Array.from({ length: count }, (_, i) => [String(i).padStart(64, '0'), 1, 1]) });

function fakeCaches() {
  const store = new Map<string, string>();
  const cache = {
    match: vi.fn(async (key: string) => (store.has(key) ? new Response(store.get(key)!) : undefined)),
    put: vi.fn(async (key: string, response: Response) => { store.set(key, await response.text()); }),
  };
  return { store, cache, storage: { open: vi.fn(async () => cache) } };
}

function fakeEngine(exported: () => string | null) {
  return {
    version: () => ({ engineSemVer: '0.9.0', engineVersion: '0.9.0', abiVersion: 3 }),
    ambientTurnVerdicts: vi.fn(exported),
    loadAmbientTurnVerdicts: vi.fn((json: string) => (JSON.parse(json) as { verdicts: unknown[] }).verdicts.length),
  } as unknown as EngineRuntime & { loadAmbientTurnVerdicts: ReturnType<typeof vi.fn>; ambientTurnVerdicts: ReturnType<typeof vi.fn> };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

// Each case re-imports the cache module after vi.resetModules() (the "next
// session"), which re-evaluates @simforge-oss/engine's module graph. That is
// a few hundred milliseconds idle and exceeded the 10 s default on a machine
// at load ~60, so these cases get room for it.
const REIMPORT_TIMEOUT_MS = 30_000;

describe('ambient turn-verdict cache', () => {
  it('persists grown tables per closure and engine, and restores them once in the next session', async () => {
    const { store, storage } = fakeCaches();
    vi.stubGlobal('caches', storage);
    const { persistAmbientTurnVerdicts } = await import('../../../src/lib/scenario/playback/ambient-turn-cache');
    const writer = fakeEngine(() => table(3));
    await persistAmbientTurnVerdicts(writer, {} as LaneGraph, 'c'.repeat(64));
    expect([...store.keys()]).toEqual([`https://simforge.invalid/ambient-turn-verdicts/0.9.0/${'c'.repeat(64)}.json`]);
    // An unchanged table is not rewritten.
    await persistAmbientTurnVerdicts(writer, {} as LaneGraph, 'c'.repeat(64));
    expect(writer.ambientTurnVerdicts).toHaveBeenCalledTimes(2);

    vi.resetModules();
    const { restoreAmbientTurnVerdicts } = await import('../../../src/lib/scenario/playback/ambient-turn-cache');
    const reader = fakeEngine(() => null);
    expect(await restoreAmbientTurnVerdicts(reader, 'c'.repeat(64))).toBe(3);
    expect(await restoreAmbientTurnVerdicts(reader, 'c'.repeat(64))).toBe(3);
    expect(reader.loadAmbientTurnVerdicts).toHaveBeenCalledTimes(1);
    expect(await restoreAmbientTurnVerdicts(reader, 'd'.repeat(64))).toBe(0);
  }, REIMPORT_TIMEOUT_MS);

  it('is a no-op without Cache Storage and survives a refused table', async () => {
    vi.stubGlobal('caches', undefined);
    const { persistAmbientTurnVerdicts, restoreAmbientTurnVerdicts } = await import('../../../src/lib/scenario/playback/ambient-turn-cache');
    const engine = fakeEngine(() => table(1));
    await persistAmbientTurnVerdicts(engine, {} as LaneGraph, 'e'.repeat(64));
    expect(await restoreAmbientTurnVerdicts(engine, 'e'.repeat(64))).toBe(0);

    vi.resetModules();
    const { storage, store } = fakeCaches();
    store.set(`https://simforge.invalid/ambient-turn-verdicts/0.9.0/${'f'.repeat(64)}.json`, table(2));
    vi.stubGlobal('caches', storage);
    const fresh = await import('../../../src/lib/scenario/playback/ambient-turn-cache');
    const refusing = fakeEngine(() => null);
    refusing.loadAmbientTurnVerdicts.mockImplementation(() => { throw new Error('turn verdicts were computed by engine 0.8.0'); });
    expect(await fresh.restoreAmbientTurnVerdicts(refusing, 'f'.repeat(64))).toBe(0);
  }, REIMPORT_TIMEOUT_MS);
});
