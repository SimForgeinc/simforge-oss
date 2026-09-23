import { afterEach, describe, expect, it, vi } from "vitest";

import {
  interpolateMapView,
  MAP_MODEL_STABLE_MS,
  mapModelsFullyLoaded,
  playInterruptibleMapZoom,
  pulledBackMapView,
  waitForMapModelsFullyLoaded,
} from "../../../../src/scenario/scene/map-camera-transition";

const near = {
  position: [10, 20, 30] as const,
  target: [0, 0, 0] as const,
  fov: 50,
};

describe("map camera transition", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
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
    expect(MAP_MODEL_STABLE_MS).toBe(0);
    expect(complete).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(complete).toHaveBeenCalledOnce();
    expect(failure).not.toHaveBeenCalled();
    cancel();
  });

  it("plays the intro zoom on a live scene and hands the camera over on the first input", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    const surface = new EventTarget();
    const applied: number[] = [];
    const onEnd = vi.fn();
    const far = pulledBackMapView(near, 2);
    playInterruptibleMapZoom(surface, (view) => applied.push(view.position[0]), far, near, 1000, onEnd);
    expect(applied).toEqual([20]); // starts pulled back
    frames.shift()!(0);
    frames.shift()!(250);
    expect(onEnd).not.toHaveBeenCalled();
    surface.dispatchEvent(new Event("pointerdown"));
    expect(onEnd).toHaveBeenCalledWith(true);
    const count = applied.length;
    frames.shift()?.(500); // a frame already queued does nothing after the takeover
    expect(applied).toHaveLength(count);
    surface.dispatchEvent(new Event("wheel"));
    expect(onEnd).toHaveBeenCalledOnce();
  });

  it("reports an uninterrupted zoom as finished", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    const onEnd = vi.fn();
    playInterruptibleMapZoom(new EventTarget(), () => undefined, pulledBackMapView(near, 2), near, 100, onEnd);
    frames.shift()!(0);
    frames.shift()!(200);
    expect(onEnd).toHaveBeenCalledWith(false);
  });

  it("counts the view as loaded once its required scope is resident, while prefetch and vegetation still stream", () => {
    const base = { roadReady: true, roadVisible: true, loading: 3, queued: 12, uploading: 2 };
    // Without the viewer's required-scope counters the whole queue must drain.
    expect(mapModelsFullyLoaded(base)).toBe(false);
    expect(mapModelsFullyLoaded({ ...base, requiredPendingAssets: 1, missingInViewTiles: 0 })).toBe(false);
    expect(mapModelsFullyLoaded({ ...base, requiredPendingAssets: 0, missingInViewTiles: 1 })).toBe(false);
    expect(mapModelsFullyLoaded({ ...base, requiredPendingAssets: 0, missingInViewTiles: 0 })).toBe(true);
    expect(mapModelsFullyLoaded({ ...base, requiredPendingAssets: 0, missingInViewTiles: 0, streamingError: "boom" })).toBe(false);
    expect(mapModelsFullyLoaded({ ...base, requiredPendingAssets: 0, missingInViewTiles: 0, roadVisible: false })).toBe(false);
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

  it("charges only visible inactivity and preserves time already spent waiting", () => {
    vi.useFakeTimers();
    const page = Object.assign(new EventTarget(), { visibilityState: "visible" });
    vi.stubGlobal("document", page);
    const complete = vi.fn();
    const failure = vi.fn();
    waitForMapModelsFullyLoaded(
      () => ({ roadReady: true, roadVisible: true, loading: 0, queued: 1, uploading: 1 }),
      complete,
      failure,
      { pollMs: 100, timeoutMs: 500 },
    );

    vi.advanceTimersByTime(200);
    page.visibilityState = "hidden";
    page.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(5_000);
    expect(failure).not.toHaveBeenCalled();
    page.visibilityState = "visible";
    page.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(299);
    expect(failure).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(failure).toHaveBeenCalledOnce();
    expect(complete).not.toHaveBeenCalled();
  });

  it("requires a fresh visible quiet window after returning to a settled map", () => {
    vi.useFakeTimers();
    const page = Object.assign(new EventTarget(), { visibilityState: "visible" });
    vi.stubGlobal("document", page);
    const complete = vi.fn();
    const failure = vi.fn();
    waitForMapModelsFullyLoaded(
      () => ({ roadReady: true, roadVisible: true, loading: 0, queued: 0, uploading: 0 }),
      complete,
      failure,
      { pollMs: 100, stableMs: 300, timeoutMs: 2_000 },
    );

    vi.advanceTimersByTime(200);
    page.visibilityState = "hidden";
    page.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(5_000);
    expect(complete).not.toHaveBeenCalled();
    expect(failure).not.toHaveBeenCalled();
    page.visibilityState = "visible";
    page.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(299);
    expect(complete).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(complete).toHaveBeenCalledOnce();
    expect(failure).not.toHaveBeenCalled();
  });

  it("still reports a streaming error while the map is hidden", () => {
    vi.useFakeTimers();
    const page = Object.assign(new EventTarget(), { visibilityState: "visible" });
    vi.stubGlobal("document", page);
    let streamingError: string | null = null;
    const complete = vi.fn();
    const failure = vi.fn();
    waitForMapModelsFullyLoaded(
      () => ({ roadReady: true, roadVisible: true, loading: 0, queued: 1, uploading: 1, streamingError }),
      complete,
      failure,
    );

    page.visibilityState = "hidden";
    page.dispatchEvent(new Event("visibilitychange"));
    streamingError = "GPU context lost";
    vi.advanceTimersByTime(100);
    expect(failure).toHaveBeenCalledOnce();
    expect(complete).not.toHaveBeenCalled();
  });

});
