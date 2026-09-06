import { afterEach, describe, expect, it, vi } from "vitest";

import {
  interpolateMapView,
  MAP_MODEL_STABLE_MS,
  MAP_ZOOM_IN_MS,
  MAP_ZOOM_OUT_MS,
  mapModelsFullyLoaded,
  pulledBackMapView,
  waitForMapModelsFullyLoaded,
} from "../../../../src/scenario/scene/map-camera-transition";

const near = {
  position: [10, 20, 30] as const,
  target: [0, 0, 0] as const,
  fov: 50,
};

describe("map camera transition", () => {
  afterEach(() => vi.useRealTimers());

  it("uses a deliberate, slow pull-back and return", () => {
    expect(MAP_ZOOM_OUT_MS).toBeGreaterThanOrEqual(1_200);
    expect(MAP_ZOOM_IN_MS).toBeGreaterThan(MAP_ZOOM_OUT_MS);
  });

  it("pulls straight back from the same orbit target", () => {
    expect(pulledBackMapView(near, 2)).toEqual({
      position: [20, 40, 60],
      target: [0, 0, 0],
      fov: 50,
    });
  });

  it("eases between the pulled-back and settled views", () => {
    const far = pulledBackMapView(near, 2);
    expect(interpolateMapView(far, near, 0)).toEqual(far);
    expect(interpolateMapView(far, near, 0.5)).toEqual({
      position: [15, 30, 45],
      target: [0, 0, 0],
      fov: 50,
    });
    expect(interpolateMapView(far, near, 1)).toEqual(near);
  });

  it("does not treat an empty queue as ready until roads and models stay settled", () => {
    vi.useFakeTimers();
    let snapshot = {
      roadReady: false,
      roadVisible: false,
      loading: 1,
      queued: 0,
      uploading: 0,
    };
    const complete = vi.fn();
    const failure = vi.fn();
    const cancel = waitForMapModelsFullyLoaded(
      () => snapshot,
      complete,
      failure,
    );

    expect(mapModelsFullyLoaded(snapshot)).toBe(false);
    snapshot = { ...snapshot, roadReady: true, roadVisible: true, loading: 0 };
    expect(mapModelsFullyLoaded({ ...snapshot, sceneAssetsReady: false })).toBe(false);
    vi.advanceTimersByTime(MAP_MODEL_STABLE_MS - 1);
    expect(complete).not.toHaveBeenCalled();
    vi.advanceTimersByTime(101);
    expect(complete).toHaveBeenCalledOnce();
    expect(failure).not.toHaveBeenCalled();
    cancel();
  });

  it("times out only after work stops progressing, not during a slow download", () => {
    vi.useFakeTimers();
    const downloads = {
      active: 1,
      transferredBytes: 0,
      totalBytes: 100,
      bytesPerSecond: 1,
      stalledForMs: 0,
    };
    const complete = vi.fn();
    const failure = vi.fn();
    waitForMapModelsFullyLoaded(
      () => ({
        roadReady: true,
        roadVisible: true,
        sceneAssetsReady: false,
        loading: 1,
        queued: 0,
        uploading: 0,
        downloads: { ...downloads },
      }),
      complete,
      failure,
      { pollMs: 100, timeoutMs: 500 },
    );

    vi.advanceTimersByTime(400);
    downloads.transferredBytes = 1;
    vi.advanceTimersByTime(100);
    vi.advanceTimersByTime(400);
    expect(failure).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(failure).toHaveBeenCalledOnce();
    expect(failure.mock.calls[0]?.[0]?.message).toContain("made no progress");
    expect(complete).not.toHaveBeenCalled();
  });

});
