import { describe, expect, it } from "vitest";
import { resolveScenarioMap, resolveScenarioMapUpgrade, ScenarioMapResolutionError } from "./scenario-map";

const binding = { mapVersionId: "old", mapSourceMapId: "di-rosa-sf", mapXodrSha256: "a".repeat(64) };
const installed = { mapVersionId: "new", sourceMapId: "di-rosa-sf", artifacts: { xodrSha256: binding.mapXodrSha256 }, topologyUrl: "/new/topology" };

describe("scenario map resolution", () => {
  it("refuses an ambiguous installed catalog instead of choosing by array order", () => {
    expect(() => resolveScenarioMapUpgrade(binding, [installed, { ...installed, mapVersionId: "another" }]))
      .toThrowError(expect.objectContaining({ code: "scenario_map_ambiguous" }));
  });
  it("never silently substitutes a newer publication for the pinned version", () => {
    expect(() => resolveScenarioMap(binding, [installed])).toThrowError(
      expect.objectContaining({ code: "scenario_map_version_superseded", requestedMapVersionId: "old", installedMapVersionId: "new" }),
    );
  });
  it("offers the compatible newer publication only as an explicit upgrade", () => {
    expect(resolveScenarioMapUpgrade(binding, [installed]).topologyUrl).toBe("/new/topology");
  });
  it("resolves the pinned version exactly when it is installed, even beside a newer one", () => {
    const pinned = { ...installed, mapVersionId: "old", topologyUrl: "/old/topology" };
    expect(resolveScenarioMap(binding, [installed, pinned]).topologyUrl).toBe("/old/topology");
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
