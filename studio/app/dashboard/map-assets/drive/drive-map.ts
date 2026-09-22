"use client";

import type { ScenarioMapEntry } from "@simforge-oss/editor";
import type { ScenarioMapDescriptorDto } from "@/app/lib/scenario/contracts";

/**
 * The editor's immutable map closure for a catalog descriptor the page already
 * holds. Field for field what the host's map catalog client derives from the
 * same wire shape, so a drive that starts from a server-rendered descriptor
 * runs on exactly the entry a drive resolved through `listMaps` would.
 */
export function driveMapEntry(map: ScenarioMapDescriptorDto): ScenarioMapEntry {
  return {
    id: map.mapVersionId,
    versionId: map.mapVersionId,
    mapVersionId: map.mapVersionId,
    sourceMapId: map.sourceMapId,
    label: map.label,
    locality: map.locality ?? "",
    browserAssetRootUrl: map.browserAssetRootUrl,
    browserManifestUrl: map.browserManifestUrl,
    browserClosureSha256: map.browserClosureSha256,
    artifacts: map.artifacts,
    sumoNetworkSha256: map.sumoNetworkSha256,
    manifestUrl: map.browserManifestUrl,
    topologyUrl: map.topologyArtifactUrl,
    derivedTopologyUrl: map.derivedTopologyUrl,
    locationsUrl: map.locationsUrl,
    signalsUrl: map.signalsArtifactUrl,
    sumoNetworkUrl: map.sumoNetworkUrl,
    xodrArtifactId: map.xodr.artifactId,
    coordinateSystemId: map.coordinateSystem.id,
  };
}
