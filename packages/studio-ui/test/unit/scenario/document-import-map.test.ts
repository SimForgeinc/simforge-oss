import { describe, expect, it } from "vitest";

import { resolveImportMap, ScenarioImportMapError } from "../../../src/scenario/list/document-json-transfer";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const newest = { mapVersionId: "usmap_new", sourceMapId: "el-camino", label: "El Camino", artifacts: { xodrSha256: SHA_B } };
const sameGeometry = { mapVersionId: "usmap_same", sourceMapId: "yale", label: "Yale", artifacts: { xodrSha256: SHA_A } };

function mapError(run: () => unknown): ScenarioImportMapError {
  try {
    run();
  } catch (error) {
    if (error instanceof ScenarioImportMapError) return error;
    throw error;
  }
  throw new Error("expected ScenarioImportMapError");
}

describe("JSON import binds the exact map version", () => {
  it("uses the listed version the file names", () => {
    expect(resolveImportMap({ mapVersionId: "usmap_new", mapXodrSha256: SHA_B }, [newest], null)).toBe(newest);
  });

  it("binds an older, still-published version rather than the newest", () => {
    const map = resolveImportMap(
      { mapVersionId: "usmap_old", mapSourceMapId: "el-camino", mapXodrSha256: SHA_A },
      [newest],
      { mapVersionId: "usmap_old", sourceMapId: "el-camino", xodrSha256: SHA_A, retiredAt: null, pinnable: true },
    );
    expect(map).toMatchObject({ mapVersionId: "usmap_old", sourceMapId: "el-camino", label: "El Camino" });
  });

  it("refuses a version whose OpenDRIVE differs from what the file declares", () => {
    const error = mapError(() => resolveImportMap({ mapVersionId: "usmap_new", mapXodrSha256: SHA_A }, [newest], null));
    expect(error.message).toMatch(/different roads/);
  });

  it("never silently uses the newest publication; a missing version fails, with a transfer offered only for identical geometry", () => {
    const drift = mapError(() => resolveImportMap({ mapVersionId: "usmap_gone", mapSourceMapId: "el-camino", mapXodrSha256: SHA_A }, [newest], null));
    expect(drift.transferTarget).toBeNull();
    expect(drift.message).toMatch(/does not exist in this installation/);
    expect(drift.message).toMatch(/different road geometry/);
    const same = mapError(() => resolveImportMap({ mapVersionId: "usmap_gone", mapSourceMapId: "yale", mapXodrSha256: SHA_A }, [sameGeometry], null));
    expect(same.transferTarget).toBe(sameGeometry);
    expect(same.message).toMatch(/transfer the scenario onto it explicitly/);
  });

  it("refuses retired versions and files without a version", () => {
    const retired = mapError(() => resolveImportMap(
      { mapVersionId: "usmap_old", mapXodrSha256: SHA_A },
      [],
      { mapVersionId: "usmap_old", sourceMapId: "el-camino", xodrSha256: SHA_A, retiredAt: "2026-09-20T00:00:00Z", pinnable: false },
    ));
    expect(retired.message).toMatch(/retired/);
    expect(mapError(() => resolveImportMap({ mapVersionId: null }, [newest], null)).message).toMatch(/does not name the exact published map version/);
  });
});
