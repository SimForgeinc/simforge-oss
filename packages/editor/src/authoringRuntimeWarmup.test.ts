import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EngineRuntime } from '@simforge-oss/engine';

import {
  authoringRuntimeReady,
  resetAuthoringRuntimeWarmupForTests,
  simulationRuntimeAssetUrls,
  warmAuthoringRuntime,
  warmSimulationAssets,
} from './authoringRuntimeWarmup';
import { LaneIndex } from './laneIndex';
import { TEST_MAP } from './map';

/**
 * The warmup only hands the engine to `LaneIndex.load`, which is mocked here,
 * so a graph decode would mean the warmup bypassed the load it is meant to
 * deduplicate.
 */
const engine: Pick<EngineRuntime, 'laneGraph'> = {
  laneGraph: () => {
    throw new Error('laneGraph must only be reached through the mocked LaneIndex.load');
  },
};

afterEach(() => {
  resetAuthoringRuntimeWarmupForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('authoring runtime warmup', () => {
  it('deduplicates the lane-index load over the awaited engine and exposes readiness only after it resolves', async () => {
    let resolve!: (index: LaneIndex) => void;
    const index = {} as LaneIndex;
    const pending = new Promise<LaneIndex>((done) => { resolve = done; });
    const load = vi.spyOn(LaneIndex, 'load').mockReturnValue(pending);

    const first = warmAuthoringRuntime(TEST_MAP, Promise.resolve(engine));
    const second = warmAuthoringRuntime(TEST_MAP, engine);
    expect(first).toBe(second);
    // The engine promise has not been awaited yet, so nothing has loaded.
    expect(load).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(load).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledWith(TEST_MAP.topologyUrl, { engine });
    expect(authoringRuntimeReady(TEST_MAP.mapVersionId)).toBe(false);

    resolve(index);
    await expect(first).resolves.toBe(index);
    expect(authoringRuntimeReady(TEST_MAP.mapVersionId)).toBe(true);
  });

  it('derives the immutable worker closure and warms it once at low priority', () => {
    const calls: Array<{ url: string; priority?: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, priority: (init as RequestInit & { priority?: string })?.priority });
      return new Response(new Uint8Array([1]));
    }));

    expect(simulationRuntimeAssetUrls(TEST_MAP)).toEqual([
      '/fixtures/test-map/map.xodr',
      '/fixtures/test-map/lane-polygons.geojson.gz',
      '/fixtures/test-map/signals.geojson.gz',
      '/fixtures/test-map/derived/topology-derived.json.gz',
      '/fixtures/test-map/derived/locations.json.gz',
    ]);
    warmSimulationAssets(TEST_MAP);
    warmSimulationAssets(TEST_MAP);

    expect(calls).toHaveLength(5);
    expect(calls.every((call) => call.priority === 'low')).toBe(true);
  });

  it('rejects a manifest outside the declared immutable asset root', () => {
    const map = { ...TEST_MAP, browserManifestUrl: '/other/3d/manifest.json' };
    expect(() => simulationRuntimeAssetUrls(map)).toThrow(/outside its declared asset root/);
  });
});
