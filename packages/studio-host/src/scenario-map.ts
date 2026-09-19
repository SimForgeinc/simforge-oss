export type ScenarioMapBinding = {
  mapVersionId: string | null;
  mapSourceMapId?: string | null;
  mapXodrSha256?: string | null;
};

type InstalledMap = {
  mapVersionId: string;
  sourceMapId?: string;
  artifacts?: { xodrSha256: string };
};

export class ScenarioMapResolutionError extends Error {
  constructor(
    readonly code: "scenario_map_absent" | "scenario_map_geometry_drift",
    message: string,
    readonly requestedMapVersionId: string | null,
    readonly installedMapVersionId: string | null = null,
  ) {
    super(message);
    this.name = "ScenarioMapResolutionError";
  }
}

/** listMaps exposes the newest installed publication of each canonical source.
 * A version is provenance, not the identity of a scenario's map. Never fall back
 * to labels or slugs: those are not proof that two maps share an origin.
 */
export function resolveScenarioMap<T extends InstalledMap>(binding: ScenarioMapBinding, installed: readonly T[]): T {
  const map = binding.mapSourceMapId
    ? installed.find((candidate) => candidate.sourceMapId === binding.mapSourceMapId)
    : installed.find((candidate) => candidate.mapVersionId === binding.mapVersionId);
  if (!map) {
    throw new ScenarioMapResolutionError(
      "scenario_map_absent",
      `The scenario's map (${binding.mapSourceMapId ?? binding.mapVersionId ?? "unbound"}) is absent from this installation. Install that source map to continue.`,
      binding.mapVersionId,
    );
  }
  if (map.mapVersionId !== binding.mapVersionId &&
      (!binding.mapXodrSha256 || binding.mapXodrSha256 !== map.artifacts?.xodrSha256)) {
    throw new ScenarioMapResolutionError(
      "scenario_map_geometry_drift",
      `The map is installed at a newer version (${map.mapVersionId}), but its OpenDRIVE geometry differs from, or cannot be verified against, the scenario's version (${binding.mapVersionId}). Remap the scenario's anchors from the old OpenDRIVE to the new before opening it.`,
      binding.mapVersionId,
      map.mapVersionId,
    );
  }
  return map;
}
