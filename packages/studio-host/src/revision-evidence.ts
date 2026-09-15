import { contentHash, type MaterializedTrafficArtifactEnvelope, type ResolvedAmbientTrafficProfile } from "@simforge-oss/engine";
import { EMPTY_AMBIENT_CONFIG_SHA256 } from "@simforge-oss/scenario";
import type { ScenarioMapEntry } from "@simforge-oss/editor";
import type { ScenarioAmbientProvenanceDto } from "./contracts";

export function ambientProvenanceForRevisionTraffic(
  artifact: MaterializedTrafficArtifactEnvelope,
  profile: ResolvedAmbientTrafficProfile,
  map: Pick<ScenarioMapEntry, "sourceMapId" | "mapVersionId" | "sumoNetworkSha256">,
): ScenarioAmbientProvenanceDto {
  const provider = artifact.artifact.provider;
  if (provider.id === "disabled") {
    return {
      mode: "disabled",
      ambientConfig: {},
      configSha256: EMPTY_AMBIENT_CONFIG_SHA256,
      resultSha256: artifact.sha256,
    };
  }
  if (provider.id === "sumo") {
    if (!map.sumoNetworkSha256) throw new Error("SUMO traffic evidence requires an immutable network digest.");
    return {
      mode: "sumo",
      sumoVersion: provider.version,
      networkSha256: map.sumoNetworkSha256,
      seed: provider.seed,
      ambientConfig: profile,
      configSha256: contentHash(profile),
      resultSha256: artifact.sha256,
    };
  }
  return {
    mode: "native",
    runtimeVersion: provider.version,
    seed: provider.seed,
    ambientConfig: profile,
    configSha256: contentHash(profile),
    resultSha256: artifact.sha256,
  };
}

