import { describe, expect, it } from "vitest";
import {
  sceneLoadProgressFromSnapshot,
} from "../../../../src/scenario/scene/map-load-progress";

const base = {
  roadReady: true,
  roadVisible: true,
  sceneAssetsReady: true,
  streamingError: null,
};

describe("scene map loading progress", () => {
  it("stays monotonic as downloader, queue, and GPU work drains", () => {
    let tracker = { peakOutstanding: 0, percent: 55 };
    const percentages: number[] = [];
    for (const snapshot of [
      { ...base, loading: 4, queued: 8, uploading: 2 },
      { ...base, loading: 2, queued: 4, uploading: 1 },
      { ...base, loading: 0, queued: 0, uploading: 0 },
    ]) {
      const next = sceneLoadProgressFromSnapshot("Belmont", snapshot, tracker);
      tracker = next.tracker;
      percentages.push(next.progress.percent ?? 0);
    }
    expect(percentages).toEqual([...percentages].sort((a, b) => a - b));
    expect(percentages.at(-1)).toBe(94);
  });

  it("does not report final readiness while a Belmont building is uploading", () => {
    const next = sceneLoadProgressFromSnapshot(
      "Belmont",
      { ...base, loading: 0, queued: 0, uploading: 1 },
      { peakOutstanding: 3, percent: 70 },
    );
    expect(next.progress.phase).toBe("assets");
    expect(next.progress.detail).toContain("1 uploading");
    expect(next.progress.percent).toBeLessThan(94);
  });

  it("only enters stabilization after all scene queues are empty", () => {
    const next = sceneLoadProgressFromSnapshot(
      "Belmont",
      { ...base, loading: 0, queued: 0, uploading: 0 },
      { peakOutstanding: 12, percent: 80 },
    );
    expect(next.progress).toMatchObject({
      phase: "stabilizing",
      percent: 94,
      message: "Finishing Belmont",
    });
  });

  it("shows byte progress and live speed for one large building asset", () => {
    const next = sceneLoadProgressFromSnapshot(
      "Belmont",
      {
        ...base,
        loading: 1,
        queued: 0,
        uploading: 0,
        downloads: {
          active: 1,
          transferredBytes: 320 * 1024 * 1024,
          totalBytes: 480 * 1024 * 1024,
          bytesPerSecond: 18.4 * 1024 * 1024,
          stalledForMs: 0,
        },
      },
      { peakOutstanding: 1, percent: 55 },
    );

    expect(next.progress.download).toEqual({
      transferred: "320 MB",
      total: "480 MB",
      speed: "18.4 MB/s",
      stalled: false,
      stalledFor: null,
    });
    expect(next.progress.percent).toBe(78);
    expect(next.progress.percentExact).toBe(true);
  });

  it("calls out a transfer that has stopped receiving bytes", () => {
    const next = sceneLoadProgressFromSnapshot(
      "Belmont",
      {
        ...base,
        loading: 1,
        queued: 0,
        uploading: 0,
        downloads: {
          active: 1,
          transferredBytes: 37 * 1024 * 1024,
          totalBytes: 400 * 1024 * 1024,
          bytesPerSecond: 0,
          stalledForMs: 8_200,
        },
      },
      { peakOutstanding: 1, percent: 55 },
    );

    expect(next.progress.download).toMatchObject({
      speed: "0 B/s",
      stalled: true,
      stalledFor: "8s",
    });
    expect(next.progress.detail).toContain("connection may be stalled");
  });
});
