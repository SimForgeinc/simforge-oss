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
    readonly code:
      | "scenario_map_absent"
      | "scenario_map_geometry_drift"
      | "scenario_map_ambiguous"
      | "scenario_map_version_superseded"
      | "scenario_map_version_unavailable"
      | "scenario_map_pin_mismatch",
    message: string,
    readonly requestedMapVersionId: string | null,
    readonly installedMapVersionId: string | null = null,
  ) {
    super(message);
    this.name = "ScenarioMapResolutionError";
  }
}

/**
 * The installed publication a document's PINNED map version names, and nothing
 * else.
 *
 * A document is pinned to one immutable map version (`drafts.map_version_id`,
 * with its closure digest and asset catalog; `docs/engineering/document-pinning.md`).
 * The editor preview, evidence and the revision commit all simulate on that
 * version, so they cannot disagree. Moving to a newer publication is an
 * explicit, recorded re-pin (`updateDocument({ mapVersionId })`), never a
 * silent substitution: when the pinned version is no longer installed but a
 * newer publication of the same source with identical OpenDRIVE is, this
 * throws `scenario_map_version_superseded` naming it
 * (`installedMapVersionId`), which the editor offers as an upgrade.
 *
 * listMaps exposes the newest installed publication of each canonical source.
 * Never fall back to labels or slugs: those are not proof that two maps share
 * an origin.
 */
export function resolveScenarioMap<T extends InstalledMap>(binding: ScenarioMapBinding, installed: readonly T[]): T {
  const exact = installed.filter((candidate) => candidate.mapVersionId === binding.mapVersionId);
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) {
    throw new ScenarioMapResolutionError(
      "scenario_map_ambiguous",
      `The installed map catalog lists version ${binding.mapVersionId} more than once. Refresh the map catalog.`,
      binding.mapVersionId,
    );
  }
  const upgrade = resolveScenarioMapUpgrade(binding, installed);
  throw new ScenarioMapResolutionError(
    "scenario_map_version_superseded",
    `This scenario is pinned to map version ${binding.mapVersionId}, which is no longer installed. `
      + `Version ${upgrade.mapVersionId} of the same map has identical road geometry; move the scenario to it to keep editing. `
      + "Moving re-simulates the scenario on the new version.",
    binding.mapVersionId,
    upgrade.mapVersionId,
  );
}

/**
 * The newer installed publication a pinned document may EXPLICITLY move to:
 * same canonical source, identical OpenDRIVE. Throws the reason there is none
 * (`scenario_map_absent`, `scenario_map_geometry_drift`, `scenario_map_ambiguous`).
 * Only an explicit re-pin may use the result; resolution never does.
 */
export function resolveScenarioMapUpgrade<T extends InstalledMap>(binding: ScenarioMapBinding, installed: readonly T[]): T {
  let map: T | undefined;
  for (const candidate of installed) {
    const matches = binding.mapSourceMapId
      ? candidate.sourceMapId === binding.mapSourceMapId
      : candidate.mapVersionId === binding.mapVersionId;
    if (!matches) continue;
    if (map) {
      throw new ScenarioMapResolutionError(
        "scenario_map_ambiguous",
        `The installed publications for source map ${binding.mapSourceMapId ?? binding.mapVersionId} are ambiguous: ${map.mapVersionId} and ${candidate.mapVersionId}. Refresh the map catalog so it identifies the newest installed publication.`,
        binding.mapVersionId,
      );
    }
    map = candidate;
  }
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
