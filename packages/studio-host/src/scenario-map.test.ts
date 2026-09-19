import { describe, expect, it } from "vitest";
import { resolveScenarioMap, ScenarioMapResolutionError } from "./scenario-map";

const binding = { mapVersionId: "old", mapSourceMapId: "di-rosa-sf", mapXodrSha256: "a".repeat(64) };
const installed = { mapVersionId: "new", sourceMapId: "di-rosa-sf", artifacts: { xodrSha256: binding.mapXodrSha256 }, topologyUrl: "/new/topology" };

describe("scenario map resolution", () => {
  it("opens a superseded scenario on the current publication of its source", () => {
    expect(resolveScenarioMap(binding, [installed]).topologyUrl).toBe("/new/topology");
  });
  it("reports a genuinely absent source, without substituting another map", () => {
    expect(() => resolveScenarioMap(binding, [{ ...installed, sourceMapId: "other" }])).toThrowError(
      expect.objectContaining({ code: "scenario_map_absent", message: expect.stringContaining("absent from this installation") }),
    );
  });
  it("refuses changed geometry instead of treating an installed source as absent", () => {
    const changed = { ...installed, artifacts: { xodrSha256: "b".repeat(64) } };
    expect(() => resolveScenarioMap(binding, [changed])).toThrowError(
      expect.objectContaining({ code: "scenario_map_geometry_drift", installedMapVersionId: "new", message: expect.stringContaining("Remap") }),
    );
  });
  it("fails closed when a superseded draft has no geometry provenance", () => {
    expect(() => resolveScenarioMap({ ...binding, mapXodrSha256: null }, [installed])).toThrow(ScenarioMapResolutionError);
  });
  it("does not infer canonical source identity from a label or version-like name", () => {
    expect(() => resolveScenarioMap({ mapVersionId: "old" }, [installed])).toThrowError(expect.objectContaining({ code: "scenario_map_absent" }));
  });
  it("keeps an exact publication usable for legacy drafts without source metadata", () => {
    expect(resolveScenarioMap({ mapVersionId: "new" }, [installed]).topologyUrl).toBe("/new/topology");
  });
});
