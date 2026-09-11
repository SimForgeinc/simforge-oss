import { describe, expect, it } from "vitest";
import { evaluateMapDownloadGuard, MAP_DOWNLOAD_DISK_RESERVE_BYTES } from "./disk-guard";

const GIB = 1024 ** 3;

describe("map download disk guard", () => {
  it("refuses an empty selection", () => {
    const guard = evaluateMapDownloadGuard({ selectedBytes: 0, selectedCount: 0, freeBytes: 100 * GIB });
    expect(guard.blocked).toBe(true);
    expect(guard.reason).toBe("Select at least one map to download.");
  });

  it("allows a selection that leaves the reserve free", () => {
    expect(
      evaluateMapDownloadGuard({
        selectedBytes: 8 * GIB,
        selectedCount: 3,
        freeBytes: 10 * GIB + MAP_DOWNLOAD_DISK_RESERVE_BYTES,
      }),
    ).toEqual({ blocked: false, reason: null });
  });

  it("allows a selection that exactly consumes the budget", () => {
    expect(
      evaluateMapDownloadGuard({
        selectedBytes: 5 * GIB,
        selectedCount: 2,
        freeBytes: 5 * GIB + MAP_DOWNLOAD_DISK_RESERVE_BYTES,
      }).blocked,
    ).toBe(false);
  });

  it("blocks one byte past the budget and explains it with both numbers", () => {
    const guard = evaluateMapDownloadGuard({
      selectedBytes: 5 * GIB + 1,
      selectedCount: 2,
      freeBytes: 5 * GIB + MAP_DOWNLOAD_DISK_RESERVE_BYTES,
    });
    expect(guard.blocked).toBe(true);
    expect(guard.reason).toContain("5.00 GB");
    expect(guard.reason).toContain("7.00 GB");
  });

  it("does not block when the host cannot report free space", () => {
    expect(
      evaluateMapDownloadGuard({ selectedBytes: 900 * GIB, selectedCount: 10, freeBytes: null }),
    ).toEqual({ blocked: false, reason: null });
  });
});
