import type { ScenarioMapEntry } from "@simforge-oss/editor";
import type { ScenarioMapOption } from "../list/document-map-groups";

/** Playback compilation needs this complete immutable map-sidecar closure. */
export function mapSupportsScenarioPreview(
  map: ScenarioMapOption,
): map is ScenarioMapOption & ScenarioMapEntry {
  return Boolean(
    map.browserManifestUrl
      && map.topologyUrl
      && map.derivedTopologyUrl
      && map.locationsUrl
      && map.id === map.mapVersionId
      && map.versionId === map.mapVersionId
      && map.sourceMapId
      && map.browserAssetRootUrl
      && map.browserClosureSha256
      && map.artifacts
      && map.sumoNetworkSha256 !== undefined,
  );
}
