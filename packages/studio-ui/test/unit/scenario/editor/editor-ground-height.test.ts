import { describe, expect, it, vi } from "vitest";
import {
  indexedEditorHeightSampler,
  waitForIndexedEditorHeightSampler,
} from "../../../../src/lib/scenario/editor/use-editor-runtime";

describe("indexedEditorHeightSampler", () => {
  it("uses the shared ground index instead of per-point scene raycasts", () => {
    const sampleNear = vi.fn((x: number, z: number) => x + z);
    const getGroundIndex = vi.fn(() => ({ sampleNear }));

    const sample = indexedEditorHeightSampler({ getGroundIndex });

    expect(sample(12, -3)).toBe(9);
    expect(sample(4, 8)).toBe(12);
    expect(getGroundIndex).toHaveBeenCalledOnce();
    expect(sampleNear).toHaveBeenCalledTimes(2);
  });

  it("retries until road geometry is available, then caches the shared index", () => {
    const sampleNear = vi.fn((x: number, z: number) => x - z);
    const getGroundIndex = vi
      .fn()
      .mockReturnValueOnce(null)
      .mockReturnValue({ sampleNear });
    const sample = indexedEditorHeightSampler({
      getGroundIndex,
    });

    expect(sample(1, 2)).toBeNull();
    expect(sample(8, 3)).toBe(5);
    expect(sample(12, 4)).toBe(8);
    expect(getGroundIndex).toHaveBeenCalledTimes(2);
    expect(sampleNear).toHaveBeenCalledTimes(2);
  });

  it("does not start the editor sampler until streamed road geometry is ready", async () => {
    vi.useFakeTimers();
    try {
      const sampleNear = vi.fn(() => 7);
      const getGroundIndex = vi
        .fn()
        .mockReturnValueOnce(null)
        .mockReturnValue({ sampleNear });
      const abort = new AbortController();

      const pending = waitForIndexedEditorHeightSampler(
        { getGroundIndex },
        abort.signal,
      );
      await vi.advanceTimersByTimeAsync(16);
      const sample = await pending;

      expect(sample(4, 5)).toBe(7);
      expect(getGroundIndex).toHaveBeenCalledTimes(2);
      expect(sampleNear).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
